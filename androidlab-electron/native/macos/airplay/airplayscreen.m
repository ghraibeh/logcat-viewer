// AirPlay screen-mirror receiver for AndroidLab (macOS-only, Wi-Fi path).
//
// The counterpart to iosscreen.swift (the USB CoreMediaIO path). Here the iPhone
// initiates: the user picks "AndroidLab" in Control Center ▸ Screen Mirroring and
// the phone streams its screen to us over the LAN via AirPlay. We advertise the
// receiver over Bonjour, run the AirPlay/RAOP + FairPlay handshake, and the vendored
// RPiPlay core (native/macos/airplay/*, GPL-3.0) decrypts the mirror stream and hands
// us **Annex-B H.264** in video_process — byte-for-byte what iosscreen emits and what
// the renderer's WebCodecs decoder already eats. We write those bytes straight to
// stdout; logs go to stderr. Stop with SIGINT/SIGTERM.
//
// The device's AUDIO is played too: the AirPlay audio stream is AAC-ELD (44.1 kHz
// stereo); we decode it with AudioToolbox's AudioConverter and play the PCM on the
// Mac's default output via an AudioQueue. SIGUSR2 toggles mute (the app's mute
// button). Audio never touches stdout, so the H.264 byte stream stays pure.
//
// View-only: AirPlay mirroring carries no input channel back to the device (touch
// forwarding stays on the USB path).
//
// Usage: airplayscreen [<advertised-name>]   (default "AndroidLab").

#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "raop.h"
#include "dnssd.h"
#include "stream.h"
#include "logger.h"
#include "ap_config.h"

// Advertised AirPlay display size (see ap_config.h). Defaults to RPiPlay's original
// 1920x1080; overridden by the `<width>x<height>` CLI arg. The source device mirrors
// at (up to) this resolution, so a larger value yields a sharper stream.
int ap_display_width = 1920;
int ap_display_height = 1080;

static void logmsg(const char *s) {
    fprintf(stderr, "%s\n", s);
    fflush(stderr);
}

// --- Annex-B H.264 → stdout ---------------------------------------------------
// video_process runs on the RAOP mirror thread; it's the only writer to stdout, so
// no locking is needed. write() can short-write on a full pipe — loop until done.
static void write_all(const unsigned char *buf, int len) {
    int off = 0;
    while (off < len) {
        ssize_t n = write(STDOUT_FILENO, buf + off, (size_t)(len - off));
        if (n <= 0) {
            if (n < 0 && (errno == EINTR)) continue;
            // The consumer (Electron) closed the pipe — nothing left to stream to.
            logmsg("airplay: stdout closed, exiting");
            _exit(0);
        }
        off += (int)n;
    }
}

static long video_frames = 0;

static void cb_video_process(void *cls, raop_ntp_t *ntp, h264_decode_struct *data) {
    (void)cls; (void)ntp;
    if (!data || !data->data || data->data_len <= 0) return;
    if (video_frames == 0) logmsg("airplay: first video frame — streaming");
    video_frames++;
    write_all(data->data, data->data_len);
}

// --- AirPlay audio (AAC-ELD 44100/stereo) → Mac's default output --------------
// The mirror audio is AAC-ELD. Its AudioSpecificConfig (bit-decoded: AOT 39 = ELD,
// freq index 4 = 44100, 2 channels, frameLengthFlag 1 = 480 samples/frame) is fixed
// for AirPlay mirroring, so we hard-configure the decoder with it as the magic
// cookie. One RTP audio packet = one 480-sample ELD access unit. Decoded PCM is
// pushed to an AudioQueue with a small recycled buffer pool.
static const UInt8 ELD_ASC[4] = {0xF8, 0xE8, 0x50, 0x00};
enum { AP_RATE = 44100, AP_CH = 2, AP_FRAME = 480, AP_NBUF = 12, AP_BUFCAP = AP_FRAME * AP_CH * 4 };

static AudioConverterRef s_conv = NULL;
static AudioQueueRef s_queue = NULL;
static AudioQueueBufferRef s_bufs[AP_NBUF];
static bool s_buf_free[AP_NBUF];
static pthread_mutex_t s_buf_mtx = PTHREAD_MUTEX_INITIALIZER;
static bool s_audio_ready = false;
static volatile sig_atomic_t s_mute_wanted = 0; // toggled by SIGUSR2
static int s_mute_applied = 0;

// One AAC access unit handed to the converter per Fill call; `done` stops the pull.
typedef struct { const void *data; UInt32 len; int done; } AacPacket;

static OSStatus aac_input_proc(AudioConverterRef c, UInt32 *ioPackets, AudioBufferList *iob,
                               AudioStreamPacketDescription **outPd, void *ud) {
    (void)c;
    AacPacket *p = (AacPacket *)ud;
    if (p->done || !p->data || p->len == 0) { *ioPackets = 0; return noErr; }
    iob->mNumberBuffers = 1;
    iob->mBuffers[0].mData = (void *)p->data;
    iob->mBuffers[0].mDataByteSize = p->len;
    iob->mBuffers[0].mNumberChannels = AP_CH;
    if (outPd) {
        static AudioStreamPacketDescription pd;
        pd.mStartOffset = 0;
        pd.mVariableFramesInPacket = 0;
        pd.mDataByteSize = p->len;
        *outPd = &pd;
    }
    *ioPackets = 1;
    p->done = 1;
    return noErr;
}

// AudioQueue playback-complete: return the buffer to the free pool.
static void aq_done(void *ud, AudioQueueRef q, AudioQueueBufferRef b) {
    (void)ud; (void)q;
    pthread_mutex_lock(&s_buf_mtx);
    for (int i = 0; i < AP_NBUF; i++) if (s_bufs[i] == b) { s_buf_free[i] = true; break; }
    pthread_mutex_unlock(&s_buf_mtx);
}

static AudioStreamBasicDescription pcm_out_asbd(void) {
    AudioStreamBasicDescription out;
    memset(&out, 0, sizeof(out));
    out.mSampleRate = AP_RATE;
    out.mFormatID = kAudioFormatLinearPCM;
    out.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    out.mChannelsPerFrame = AP_CH;
    out.mBitsPerChannel = 16;
    out.mFramesPerPacket = 1;
    out.mBytesPerFrame = AP_CH * 2;
    out.mBytesPerPacket = AP_CH * 2;
    return out;
}

static bool audio_setup(void) {
    AudioStreamBasicDescription in;
    memset(&in, 0, sizeof(in));
    in.mSampleRate = AP_RATE;
    in.mFormatID = kAudioFormatMPEG4AAC_ELD;
    in.mChannelsPerFrame = AP_CH;
    in.mFramesPerPacket = AP_FRAME;
    AudioStreamBasicDescription out = pcm_out_asbd();

    if (AudioConverterNew(&in, &out, &s_conv) != noErr) { logmsg("airplay: AAC-ELD decoder init failed"); return false; }
    AudioConverterSetProperty(s_conv, kAudioConverterDecompressionMagicCookie, sizeof(ELD_ASC), ELD_ASC);

    if (AudioQueueNewOutput(&out, aq_done, NULL, NULL, NULL, 0, &s_queue) != noErr) {
        logmsg("airplay: audio output init failed");
        AudioConverterDispose(s_conv);
        s_conv = NULL;
        return false;
    }
    for (int i = 0; i < AP_NBUF; i++) {
        AudioQueueAllocateBuffer(s_queue, AP_BUFCAP, &s_bufs[i]);
        s_buf_free[i] = true;
    }
    AudioQueueStart(s_queue, NULL);
    s_audio_ready = true;
    logmsg("airplay: audio — decoding AAC-ELD, playing on the Mac's default output");
    return true;
}

static AudioQueueBufferRef take_free_buffer(void) {
    AudioQueueBufferRef b = NULL;
    pthread_mutex_lock(&s_buf_mtx);
    for (int i = 0; i < AP_NBUF; i++) if (s_buf_free[i]) { s_buf_free[i] = false; b = s_bufs[i]; break; }
    pthread_mutex_unlock(&s_buf_mtx);
    return b;
}

static void audio_feed(const void *aac, UInt32 len) {
    if (!s_audio_ready && !audio_setup()) return;

    // Apply a pending mute toggle here (signal-handler-safe: the handler only flips a
    // flag; the AudioQueue call happens on this audio thread).
    if (s_mute_applied != s_mute_wanted) {
        s_mute_applied = s_mute_wanted;
        AudioQueueSetParameter(s_queue, kAudioQueueParam_Volume, s_mute_wanted ? 0.0f : 1.0f);
    }

    AudioQueueBufferRef buf = take_free_buffer();
    if (!buf) return; // output falling behind — drop this frame (it's real-time audio)

    AacPacket pkt = { aac, len, 0 };
    UInt32 outPackets = AP_FRAME; // one ELD access unit → up to 480 PCM frames
    AudioBufferList abl;
    abl.mNumberBuffers = 1;
    abl.mBuffers[0].mNumberChannels = AP_CH;
    abl.mBuffers[0].mDataByteSize = buf->mAudioDataBytesCapacity;
    abl.mBuffers[0].mData = buf->mAudioData;

    AudioConverterFillComplexBuffer(s_conv, aac_input_proc, &pkt, &outPackets, &abl, NULL);
    if (outPackets == 0) { aq_done(NULL, s_queue, buf); return; } // decode produced nothing
    buf->mAudioDataByteSize = abl.mBuffers[0].mDataByteSize;
    AudioQueueEnqueueBuffer(s_queue, buf, 0, NULL);
}

static void audio_teardown(void) {
    if (s_queue) { AudioQueueStop(s_queue, true); AudioQueueDispose(s_queue, true); s_queue = NULL; }
    if (s_conv) { AudioConverterDispose(s_conv); s_conv = NULL; }
    s_audio_ready = false;
}

static long audio_pkts = 0;
static void cb_audio_process(void *cls, raop_ntp_t *ntp, aac_decode_struct *data) {
    (void)cls; (void)ntp;
    if (!data || !data->data || data->data_len <= 0) return;
    if (audio_pkts == 0) logmsg("airplay: audio stream — decoding + playing");
    audio_pkts++;
    audio_feed(data->data, (UInt32)data->data_len);
}

static void cb_conn_init(void *cls) { (void)cls; logmsg("airplay: client connected"); }
static void cb_conn_destroy(void *cls) { (void)cls; logmsg("airplay: client disconnected"); }
static void cb_video_flush(void *cls) { (void)cls; }
static void cb_audio_flush(void *cls) { (void)cls; }
static void cb_audio_set_volume(void *cls, float v) { (void)cls; (void)v; }

static void log_callback(void *cls, int level, const char *msg) {
    (void)cls;
    if (level <= RAOP_LOG_WARNING) logmsg(msg); // errors + warnings only, keep stderr sane
}

// --- host MAC (the AirPlay device id in the Bonjour TXT record) ----------------
// AirPlay identifies a receiver by a 6-byte hardware address. Use the primary
// interface's real MAC so the receiver has a stable, unique id on the LAN; fall back
// to a fixed address if none is found.
static void primary_hw_addr(char out[6]) {
    static const char fallback[6] = {0x48, 0x5d, 0x60, 0x7c, (char)0xee, 0x22};
    memcpy(out, fallback, 6);
    struct ifaddrs *ifap = NULL;
    if (getifaddrs(&ifap) != 0) return;
    for (struct ifaddrs *p = ifap; p; p = p->ifa_next) {
        if (p->ifa_addr && p->ifa_addr->sa_family == AF_LINK &&
            p->ifa_name && strcmp(p->ifa_name, "en0") == 0) {
            struct sockaddr_dl *dl = (struct sockaddr_dl *)p->ifa_addr;
            if (dl->sdl_alen == 6) {
                memcpy(out, LLADDR(dl), 6);
                break;
            }
        }
    }
    freeifaddrs(ifap);
}

// --- lifetime -----------------------------------------------------------------
static volatile sig_atomic_t g_stop = 0;
static void on_signal(int sig) { (void)sig; g_stop = 1; }
// SIGUSR2 (the app's mute button) toggles audio mute; applied on the audio thread.
static void on_mute(int sig) { (void)sig; s_mute_wanted = s_mute_wanted ? 0 : 1; }

int main(int argc, char *argv[]) {
    @autoreleasepool {
        const char *name = (argc > 1 && argv[1][0]) ? argv[1] : "AndroidLab";

        // Optional "<width>x<height>" advertised resolution (e.g. "2560x1440").
        if (argc > 2 && argv[2][0]) {
            int w = 0, h = 0;
            if (sscanf(argv[2], "%dx%d", &w, &h) == 2 && w >= 640 && h >= 360 && w <= 7680 && h <= 4320) {
                ap_display_width = w;
                ap_display_height = h;
            } else {
                fprintf(stderr, "airplay: ignoring bad resolution arg \"%s\" (want WxH)\n", argv[2]);
            }
        }
        fprintf(stderr, "airplay: advertised display %dx%d\n", ap_display_width, ap_display_height);

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

        raop_t *raop = raop_init(10, &cbs);
        if (!raop) { logmsg("airplay: raop_init failed"); return 2; }
        raop_set_log_callback(raop, log_callback, NULL);
        raop_set_log_level(raop, RAOP_LOG_WARNING);

        unsigned short port = 0;
        if (raop_start(raop, &port) < 0) { logmsg("airplay: raop_start failed"); return 2; }
        raop_set_port(raop, port);

        char hw[6];
        primary_hw_addr(hw);
        int err = 0;
        dnssd_t *dnssd = dnssd_init(name, (int)strlen(name), hw, 6, &err);
        if (err) { logmsg("airplay: dnssd_init failed (is another receiver running?)"); raop_destroy(raop); return 2; }
        raop_set_dnssd(raop, dnssd);
        dnssd_register_raop(dnssd, port);
        dnssd_register_airplay(dnssd, port + 1);

        fprintf(stderr, "airplay: advertising \"%s\" (raop :%u / airplay :%u) — pick it in Control Center ▸ Screen Mirroring\n",
                name, port, port + 1);
        fflush(stderr);

        signal(SIGINT, on_signal);
        signal(SIGTERM, on_signal);
        signal(SIGUSR2, on_mute);
        while (!g_stop) pause();

        logmsg("airplay: shutting down");
        audio_teardown();
        dnssd_unregister_raop(dnssd);
        dnssd_unregister_airplay(dnssd);
        raop_destroy(raop);
        dnssd_destroy(dnssd);
    }
    return 0;
}
