/*
 * JNI bridge for the Android AirPlay screen-mirror receiver.
 *
 * This is the Android equivalent of the desktop receiver's airplayscreen.c main(): it
 * drives the SAME vendored RPiPlay core (RAOP + FairPlay + bonjour_shim mDNS), but
 * instead of writing Annex-B H.264 to stdout it hands each frame up to Kotlin, which
 * decodes it on the phone's hardware H.264 decoder (MediaCodec) into a SurfaceView.
 *
 * The mirror AUDIO (AAC-ELD, 44.1 kHz stereo) is decoded and played entirely in native
 * here — fdk-aac -> a small ring buffer -> miniaudio (AAudio/OpenSL on Android) — the
 * byte-for-byte same path the desktop uses, so it never crosses JNI.
 *
 * One receiver per process (globals, like the desktop main). Lifecycle:
 *   nativeStart(name, w, h, hwHex, listener) -> raop port (>0) or negative error
 *   nativeSetMuted(bool)
 *   nativeStop()
 */
#include <jni.h>
#include <android/log.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>

#include <fdk-aac/aacdecoder_lib.h>
#include "miniaudio.h"

#include "raop.h"
#include "raop_rtp_mirror.h"
#include "dnssd.h"
#include "stream.h"
#include "logger.h"
#include "threads.h"
#include "ap_config.h"

#define LOG_TAG "airplay-native"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/* Advertised AirPlay display size (see ap_config.h / raop_handlers.h). Defined here
 * because we drop airplayscreen.c which normally owns these. */
int ap_display_width = 1920;
int ap_display_height = 1080;

/* --- JNI plumbing ----------------------------------------------------------- */
static JavaVM *g_vm = NULL;
static jobject g_listener = NULL;      /* global ref to the Kotlin Listener */
static jmethodID g_mid_video = NULL;   /* onVideoFrame([BJZ)V */
static jmethodID g_mid_conn = NULL;    /* onClientConnected()V */
static jmethodID g_mid_disc = NULL;    /* onClientDisconnected()V */

static raop_t *g_raop = NULL;
static dnssd_t *g_dnssd = NULL;

/* Attach the calling (RAOP core) thread to the JVM if needed. Video/conn callbacks run
 * on core-owned threads; we attach per call and detach after so a core thread never
 * exits still-attached (which ART turns into a fatal abort). ~60 calls/s — negligible. */
static JNIEnv *attach_env(int *did_attach) {
    JNIEnv *env = NULL;
    *did_attach = 0;
    if (!g_vm) return NULL;
    jint r = (*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6);
    if (r == JNI_EDETACHED) {
        if ((*g_vm)->AttachCurrentThread(g_vm, &env, NULL) != 0) return NULL;
        *did_attach = 1;
    } else if (r != JNI_OK) {
        return NULL;
    }
    return env;
}
static void detach_env(int did_attach) {
    if (did_attach && g_vm) (*g_vm)->DetachCurrentThread(g_vm);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    g_vm = vm;
    return JNI_VERSION_1_6;
}

/* --- video: RPiPlay core -> Kotlin MediaCodec ------------------------------- */
/* frame_type in the core: 0 = SPS/PPS codec config, 1 = frame NALUs (IDR or P). Both
 * arrive already as Annex-B (00 00 00 01 start codes). We pass isConfig up so the
 * Kotlin decoder can configure MediaCodec from the SPS/PPS. */
static long g_video_frames = 0;
static void cb_video_process(void *cls, raop_ntp_t *ntp, h264_decode_struct *data) {
    (void)cls; (void)ntp;
    if (!data || !data->data || data->data_len <= 0) return;
    if (!g_listener || !g_mid_video) return;
    if (g_video_frames == 0) LOGI("first video unit (%d bytes)", data->data_len);
    g_video_frames++;

    int did = 0;
    JNIEnv *env = attach_env(&did);
    if (!env) return;

    jbyteArray arr = (*env)->NewByteArray(env, data->data_len);
    if (arr) {
        (*env)->SetByteArrayRegion(env, arr, 0, data->data_len, (const jbyte *)data->data);
        jboolean isConfig = (data->frame_type == 0) ? JNI_TRUE : JNI_FALSE;
        (*env)->CallVoidMethod(env, g_listener, g_mid_video, arr, (jlong)data->pts, isConfig);
        if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
        (*env)->DeleteLocalRef(env, arr);
    }
    detach_env(did);
}

static void notify_conn(jmethodID mid) {
    if (!g_listener || !mid) return;
    int did = 0;
    JNIEnv *env = attach_env(&did);
    if (!env) return;
    (*env)->CallVoidMethod(env, g_listener, mid);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    detach_env(did);
}
static void cb_conn_init(void *cls)    { (void)cls; LOGI("client connected");    g_video_frames = 0; notify_conn(g_mid_conn); }
static void cb_conn_destroy(void *cls) { (void)cls; LOGI("client disconnected"); notify_conn(g_mid_disc); }
static void cb_video_flush(void *cls)  { (void)cls; }

/* --- audio: AAC-ELD (fdk-aac) -> ring buffer -> miniaudio -------------------- */
/* Verbatim from the desktop receiver (airplayscreen.c): AirPlay mirror audio is a
 * fixed AAC-ELD config (AOT 39, 44100, 2ch, 480 samples/frame). */
static const unsigned char ELD_ASC[4] = {0xF8, 0xE8, 0x50, 0x00};
enum { AP_RATE = 44100, AP_CH = 2 };
#define RB_FRAMES 22050 /* ~0.5 s of stereo s16 headroom */

static HANDLE_AACDECODER s_dec = NULL;
static ma_device s_device;
static int s_audio_ready = 0;
static volatile int s_mute = 0;

static int16_t s_rb[RB_FRAMES * AP_CH];
static size_t s_rb_head = 0, s_rb_tail = 0; /* in frames */
static mutex_handle_t s_rb_mtx;

static void ma_data_cb(ma_device *dev, void *out, const void *in, ma_uint32 frames) {
    (void)dev; (void)in;
    int16_t *o = (int16_t *)out;
    MUTEX_LOCK(s_rb_mtx);
    for (ma_uint32 i = 0; i < frames; ++i) {
        if (s_rb_tail != s_rb_head && !s_mute) {
            o[i * 2] = s_rb[s_rb_tail * 2];
            o[i * 2 + 1] = s_rb[s_rb_tail * 2 + 1];
            s_rb_tail = (s_rb_tail + 1) % RB_FRAMES;
        } else {
            o[i * 2] = 0;
            o[i * 2 + 1] = 0;
            if (s_rb_tail != s_rb_head) s_rb_tail = (s_rb_tail + 1) % RB_FRAMES; /* drain while muted */
        }
    }
    MUTEX_UNLOCK(s_rb_mtx);
}

static int audio_setup(void) {
    s_dec = aacDecoder_Open(TT_MP4_RAW, 1);
    if (!s_dec) { LOGW("AAC-ELD decoder open failed"); return 0; }
    UCHAR asc[4];
    memcpy(asc, ELD_ASC, 4);
    UCHAR *conf[1] = {asc};
    UINT conf_len[1] = {4};
    if (aacDecoder_ConfigRaw(s_dec, conf, conf_len) != AAC_DEC_OK) {
        LOGW("AAC-ELD config failed");
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    MUTEX_CREATE(s_rb_mtx);

    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format = ma_format_s16;
    cfg.playback.channels = AP_CH;
    cfg.sampleRate = AP_RATE;
    cfg.dataCallback = ma_data_cb;
    if (ma_device_init(NULL, &cfg, &s_device) != MA_SUCCESS) {
        LOGW("audio output init failed");
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    if (ma_device_start(&s_device) != MA_SUCCESS) {
        LOGW("audio output start failed");
        ma_device_uninit(&s_device);
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    s_audio_ready = 1;
    LOGI("audio ready — decoding AAC-ELD, playing on default output");
    return 1;
}

static void rb_push(const int16_t *pcm, size_t frames) {
    MUTEX_LOCK(s_rb_mtx);
    for (size_t i = 0; i < frames; ++i) {
        size_t next = (s_rb_head + 1) % RB_FRAMES;
        if (next == s_rb_tail) break; /* full — drop (real-time audio) */
        s_rb[s_rb_head * 2] = pcm[i * 2];
        s_rb[s_rb_head * 2 + 1] = pcm[i * 2 + 1];
        s_rb_head = next;
    }
    MUTEX_UNLOCK(s_rb_mtx);
}

static long s_audio_pkts = 0;
static void cb_audio_process(void *cls, raop_ntp_t *ntp, aac_decode_struct *data) {
    (void)cls; (void)ntp;
    if (!data || !data->data || data->data_len <= 0) return;
    if (!s_audio_ready && !audio_setup()) return;
    if (s_audio_pkts == 0) LOGI("audio stream — decoding + playing");
    s_audio_pkts++;

    UCHAR *inbuf = (UCHAR *)data->data;
    UINT insize = (UINT)data->data_len, valid = (UINT)data->data_len;
    if (aacDecoder_Fill(s_dec, &inbuf, &insize, &valid) != AAC_DEC_OK) return;
    INT_PCM pcm[2048 * AP_CH];
    if (aacDecoder_DecodeFrame(s_dec, pcm, 2048 * AP_CH, 0) != AAC_DEC_OK) return;
    CStreamInfo *info = aacDecoder_GetStreamInfo(s_dec);
    if (!info || info->numChannels <= 0 || info->frameSize <= 0) return;
    if (info->numChannels == AP_CH) {
        rb_push((int16_t *)pcm, (size_t)info->frameSize);
    } else {
        int16_t st[2048 * AP_CH];
        for (int i = 0; i < info->frameSize && i < 2048; ++i) {
            st[i * 2] = pcm[i];
            st[i * 2 + 1] = pcm[i];
        }
        rb_push(st, (size_t)info->frameSize);
    }
}

static void audio_teardown(void) {
    if (s_audio_ready) { ma_device_uninit(&s_device); s_audio_ready = 0; }
    if (s_dec) { aacDecoder_Close(s_dec); s_dec = NULL; }
    s_audio_pkts = 0;
}

static void cb_audio_flush(void *cls) { (void)cls; }
static void cb_audio_set_volume(void *cls, float v) { (void)cls; (void)v; }

static void log_callback(void *cls, int level, const char *msg) {
    (void)cls;
    /* Map the RAOP core's levels onto Android's so DEBUG-level protocol tracing (feedback
     * heartbeats, mirror payload types, NTP round-trips, httpd connection closes) is
     * available in logcat without drowning the W channel. */
    if (level <= RAOP_LOG_WARNING) {
        LOGW("%s", msg);
    } else if (level <= RAOP_LOG_INFO) {
        LOGI("%s", msg);
    } else {
        __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, "%s", msg);
    }
}

/* --- hw address for the mDNS deviceid --------------------------------------- */
/* Android hides the real Wi-Fi MAC from apps, and it's only the AirPlay deviceid TXT
 * anyway — so Kotlin passes a stable per-install 12-hex-char id (from ANDROID_ID). */
static void parse_hw(const char *hex, char out[6]) {
    static const unsigned char fallback[6] = {0x48, 0x5d, 0x60, 0x7c, 0xee, 0x23};
    memcpy(out, fallback, 6);
    if (!hex) return;
    int n = 0;
    unsigned int b;
    for (int i = 0; i < 6 && hex[n] && hex[n + 1]; ++i, n += 2) {
        char pair[3] = {hex[n], hex[n + 1], 0};
        if (sscanf(pair, "%02x", &b) != 1) return;
        out[i] = (char)b;
    }
}

/* --- JNI entry points ------------------------------------------------------- */
JNIEXPORT jint JNICALL
Java_com_mobilelabkit_airplay_NativeReceiver_nativeStart(
        JNIEnv *env, jobject thiz, jstring jname, jint width, jint height,
        jstring jhw, jobject listener) {
    (void)thiz;
    if (g_raop) { LOGW("already running"); return -10; }

    /* cache the listener + its methods */
    jclass lc = (*env)->GetObjectClass(env, listener);
    g_mid_video = (*env)->GetMethodID(env, lc, "onVideoFrame", "([BJZ)V");
    g_mid_conn  = (*env)->GetMethodID(env, lc, "onClientConnected", "()V");
    g_mid_disc  = (*env)->GetMethodID(env, lc, "onClientDisconnected", "()V");
    if (!g_mid_video || !g_mid_conn || !g_mid_disc) { LOGE("listener method lookup failed"); return -11; }
    g_listener = (*env)->NewGlobalRef(env, listener);

    if (width >= 640 && height >= 360 && width <= 7680 && height <= 4320) {
        ap_display_width = width;
        ap_display_height = height;
    }

    // jstring is an opaque handle (void* in C) — never deref it; decode to UTF-8 first.
    const char *name_c = jname ? (*env)->GetStringUTFChars(env, jname, NULL) : NULL;
    const char *name = (name_c && name_c[0]) ? name_c : "MobileLabKit";
    const char *hw = jhw ? (*env)->GetStringUTFChars(env, jhw, NULL) : NULL;

    raop_callbacks_t cbs;
    memset(&cbs, 0, sizeof(cbs));
    cbs.cls = NULL;
    cbs.conn_init = cb_conn_init;
    cbs.conn_destroy = cb_conn_destroy;
    cbs.audio_process = cb_audio_process;
    cbs.video_process = cb_video_process;
    cbs.audio_flush = cb_audio_flush;
    cbs.video_flush = cb_video_flush;
    cbs.audio_set_volume = cb_audio_set_volume;

    jint result = -1;
    g_raop = raop_init(10, &cbs);
    if (!g_raop) { LOGE("raop_init failed"); goto done; }
    raop_set_log_callback(g_raop, log_callback, NULL);
    /* INFO keeps the connection-lifecycle forensics ("Connection closed for socket N",
     * client connect/disconnect) that W-only hid, without DEBUG's per-packet firehose.
     * For protocol-level tracing (per-second feedback/heartbeats, payload types, NTP
     * round-trips) flip this to RAOP_LOG_DEBUG — log_callback maps levels onto Android's
     * W/I/D channels. */
    raop_set_log_level(g_raop, RAOP_LOG_INFO);

    unsigned short port = 0;
    if (raop_start(g_raop, &port) < 0) { LOGE("raop_start failed"); raop_destroy(g_raop); g_raop = NULL; goto done; }
    raop_set_port(g_raop, port);

    char hwb[6];
    parse_hw(hw, hwb);
    int err = 0;
    g_dnssd = dnssd_init(name, (int)strlen(name), hwb, 6, &err);
    if (err || !g_dnssd) { LOGE("dnssd_init failed (%d)", err); raop_destroy(g_raop); g_raop = NULL; goto done; }
    raop_set_dnssd(g_raop, g_dnssd);
    dnssd_register_raop(g_dnssd, port);
    dnssd_register_airplay(g_dnssd, port + 1);

    LOGI("advertising \"%s\" raop:%u airplay:%u  %dx%d", name, port, port + 1, ap_display_width, ap_display_height);
    result = (jint)port;

done:
    if (name_c) (*env)->ReleaseStringUTFChars(env, jname, name_c);
    if (hw) (*env)->ReleaseStringUTFChars(env, jhw, hw);
    if (result < 0 && g_listener) { (*env)->DeleteGlobalRef(env, g_listener); g_listener = NULL; }
    return result;
}

JNIEXPORT void JNICALL
Java_com_mobilelabkit_airplay_NativeReceiver_nativeSetMuted(JNIEnv *env, jobject thiz, jboolean muted) {
    (void)env; (void)thiz;
    s_mute = muted ? 1 : 0;
}

/* Decoder-requested video stream restart: drop the mirror TCP connection so the client
 * re-establishes it (a stream (re)start always leads with SPS/PPS + IDR). Used as the
 * escape hatch when the decoder is starved for a keyframe — the protocol has no way to
 * ask the sender for one. */
JNIEXPORT void JNICALL
Java_com_mobilelabkit_airplay_NativeReceiver_nativeNudgeVideo(JNIEnv *env, jobject thiz) {
    (void)env; (void)thiz;
    raop_rtp_mirror_request_nudge();
}

JNIEXPORT void JNICALL
Java_com_mobilelabkit_airplay_NativeReceiver_nativeStop(JNIEnv *env, jobject thiz) {
    (void)thiz;
    LOGI("stopping");
    if (g_dnssd) {
        dnssd_unregister_raop(g_dnssd);
        dnssd_unregister_airplay(g_dnssd);
    }
    if (g_raop) { raop_destroy(g_raop); g_raop = NULL; }
    if (g_dnssd) { dnssd_destroy(g_dnssd); g_dnssd = NULL; }
    audio_teardown();
    if (g_listener) { (*env)->DeleteGlobalRef(env, g_listener); g_listener = NULL; }
    g_mid_video = g_mid_conn = g_mid_disc = NULL;
    g_video_frames = 0;
}
