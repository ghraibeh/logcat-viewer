/*
 * AirPlay screen-mirror receiver for MobileLabKit — cross-platform (macOS/Windows/Linux).
 *
 * The Wi-Fi counterpart to the USB CoreMediaIO path (macOS only). The iPhone initiates:
 * the user picks "MobileLabKit" in Control Center > Screen Mirroring and streams its
 * screen to us over the LAN via AirPlay. We advertise the receiver over mDNS (the
 * bundled bonjour_shim — no OS Bonjour/Avahi), run the AirPlay/RAOP + FairPlay
 * handshake, and the vendored RPiPlay core hands us Annex-B H.264 in video_process —
 * byte-for-byte what the USB path emits and what the renderer's WebCodecs decoder eats.
 * Those bytes go straight to stdout; logs go to stderr.
 *
 * The device AUDIO (AirPlay mirror audio is AAC-ELD, 44.1 kHz stereo) is decoded with
 * fdk-aac and played on the host's default output via miniaudio. Audio never touches
 * stdout, so the H.264 byte stream stays pure.
 *
 * Control: SIGINT/SIGTERM (or stdin EOF) shuts down; a 'm' byte on stdin toggles mute
 * (portable replacement for the old SIGUSR2 — Windows has no POSIX signals).
 *
 * Usage: airplayscreen [<advertised-name>] [<WxH>]   (defaults "MobileLabKit" 1920x1080)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <iphlpapi.h>
#  include <io.h>
#  include <fcntl.h>
#else
#  include <unistd.h>
#  include <sys/socket.h>
#  include <net/if.h>
#  include <ifaddrs.h>
#  ifdef __APPLE__
#    include <net/if_dl.h>
#  else
#    include <netpacket/packet.h>
#  endif
#endif

#include <fdk-aac/aacdecoder_lib.h>
#include "miniaudio.h"

#include "raop.h"
#include "dnssd.h"
#include "stream.h"
#include "logger.h"
#include "threads.h"
#include "ap_config.h"

/* Advertised AirPlay display size (see ap_config.h / raop_handlers.h). */
int ap_display_width = 1920;
int ap_display_height = 1080;

static void logmsg(const char *s) {
    fprintf(stderr, "%s\n", s);
    fflush(stderr);
}

/* --- Annex-B H.264 -> stdout ------------------------------------------------- */
/* video_process runs on the RAOP mirror thread; it's the only writer to stdout. */
static void write_all(const unsigned char *buf, int len) {
    int off = 0;
    while (off < len) {
#ifdef _WIN32
        int n = _write(_fileno(stdout), buf + off, (unsigned)(len - off));
#else
        ssize_t n = write(STDOUT_FILENO, buf + off, (size_t)(len - off));
#endif
        if (n <= 0) {
            logmsg("airplay: stdout closed, exiting");
            fflush(stdout);
            _Exit(0);
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

/* --- AirPlay audio: AAC-ELD (fdk-aac) -> ring buffer -> miniaudio ------------ */
/* The mirror audio's AudioSpecificConfig is fixed for AirPlay: AOT 39 (ELD), freq
 * index 4 (44100), 2 channels, 480 samples/frame. We hand it to fdk-aac as the raw
 * config and decode one access unit per RTP audio packet. */
static const unsigned char ELD_ASC[4] = {0xF8, 0xE8, 0x50, 0x00};
enum { AP_RATE = 44100, AP_CH = 2 };
#define RB_FRAMES 22050 /* ~0.5 s of stereo s16 headroom */

static HANDLE_AACDECODER s_dec = NULL;
static ma_device s_device;
static int s_audio_ready = 0;
static volatile int s_mute = 0;

/* Interleaved s16 ring buffer (frames = sample pairs). Guarded by a short-held mutex;
 * the miniaudio callback and the RAOP audio thread are the only participants. */
static int16_t s_rb[RB_FRAMES * AP_CH];
static size_t s_rb_head = 0, s_rb_tail = 0; /* in frames */
static mutex_handle_t s_rb_mtx;

static size_t rb_count(void) { return (s_rb_head + RB_FRAMES - s_rb_tail) % RB_FRAMES; }

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
    if (!s_dec) { logmsg("airplay: AAC-ELD decoder open failed"); return 0; }
    UCHAR asc[4];
    memcpy(asc, ELD_ASC, 4);
    UCHAR *conf[1] = {asc};
    UINT conf_len[1] = {4};
    if (aacDecoder_ConfigRaw(s_dec, conf, conf_len) != AAC_DEC_OK) {
        logmsg("airplay: AAC-ELD config failed");
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    MUTEX_CREATE(s_rb_mtx);

    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format = ma_format_s16;
    cfg.playback.channels = AP_CH;
    cfg.sampleRate = AP_RATE;
    cfg.dataCallback = ma_data_cb;
    if (ma_device_init(NULL, &cfg, &s_device) != MA_SUCCESS) {
        logmsg("airplay: audio output init failed");
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    if (ma_device_start(&s_device) != MA_SUCCESS) {
        logmsg("airplay: audio output start failed");
        ma_device_uninit(&s_device);
        aacDecoder_Close(s_dec); s_dec = NULL; return 0;
    }
    s_audio_ready = 1;
    logmsg("airplay: audio — decoding AAC-ELD, playing on the default output");
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

static long audio_pkts = 0;
static void cb_audio_process(void *cls, raop_ntp_t *ntp, aac_decode_struct *data) {
    (void)cls; (void)ntp;
    if (!data || !data->data || data->data_len <= 0) return;
    if (!s_audio_ready && !audio_setup()) return;
    if (audio_pkts == 0) logmsg("airplay: audio stream — decoding + playing");
    audio_pkts++;

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
        /* Up-mix mono to stereo just in case. */
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
}

static void cb_conn_init(void *cls) { (void)cls; logmsg("airplay: client connected"); }
static void cb_conn_destroy(void *cls) { (void)cls; logmsg("airplay: client disconnected"); }
static void cb_video_flush(void *cls) { (void)cls; }
static void cb_audio_flush(void *cls) { (void)cls; }
static void cb_audio_set_volume(void *cls, float v) { (void)cls; (void)v; }

static void log_callback(void *cls, int level, const char *msg) {
    (void)cls;
    if (level <= RAOP_LOG_WARNING) logmsg(msg);
}

/* --- host MAC (the AirPlay device id in the mDNS TXT record) ------------------ */
static void primary_hw_addr(char out[6]) {
    static const unsigned char fallback[6] = {0x48, 0x5d, 0x60, 0x7c, 0xee, 0x22};
    memcpy(out, fallback, 6);
#ifdef _WIN32
    ULONG sz = 16 * 1024;
    IP_ADAPTER_ADDRESSES *aa = (IP_ADAPTER_ADDRESSES *)malloc(sz);
    if (aa && GetAdaptersAddresses(AF_UNSPEC, 0, NULL, aa, &sz) == NO_ERROR) {
        for (IP_ADAPTER_ADDRESSES *a = aa; a; a = a->Next) {
            if (a->OperStatus == IfOperStatusUp && a->PhysicalAddressLength == 6) {
                memcpy(out, a->PhysicalAddress, 6);
                break;
            }
        }
    }
    free(aa);
#else
    struct ifaddrs *ifap = NULL;
    if (getifaddrs(&ifap) != 0) return;
    for (struct ifaddrs *p = ifap; p; p = p->ifa_next) {
        if (!p->ifa_addr) continue;
#  ifdef __APPLE__
        if (p->ifa_addr->sa_family == AF_LINK && p->ifa_name &&
            (strcmp(p->ifa_name, "en0") == 0)) {
            struct sockaddr_dl *dl = (struct sockaddr_dl *)p->ifa_addr;
            if (dl->sdl_alen == 6) { memcpy(out, LLADDR(dl), 6); break; }
        }
#  else
        if (p->ifa_addr->sa_family == AF_PACKET && p->ifa_name &&
            !(p->ifa_flags & IFF_LOOPBACK)) {
            struct sockaddr_ll *ll = (struct sockaddr_ll *)p->ifa_addr;
            if (ll->sll_halen == 6) { memcpy(out, ll->sll_addr, 6); break; }
        }
#  endif
    }
    freeifaddrs(ifap);
#endif
}

/* --- control (mute over stdin) + lifetime ------------------------------------ */
static volatile sig_atomic_t g_stop = 0;
static void on_signal(int sig) { (void)sig; g_stop = 1; }

/* Reads stdin: a 'm' byte toggles mute; EOF (parent closed the pipe) shuts us down.
 * Portable replacement for the old SIGUSR2 mute (Windows has no POSIX signals). */
static THREAD_RETVAL stdin_thread(void *arg) {
    (void)arg;
    int c;
    while ((c = getchar()) != EOF) {
        if (c == 'm' || c == 'M') s_mute = !s_mute;
    }
    g_stop = 1; /* stdin closed => parent gone */
    return (THREAD_RETVAL)0;
}

int main(int argc, char *argv[]) {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    _setmode(_fileno(stdout), _O_BINARY); /* keep the H.264 byte stream intact */
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    const char *name = (argc > 1 && argv[1][0]) ? argv[1] : "MobileLabKit";

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
    if (err) { logmsg("airplay: dnssd_init failed"); raop_destroy(raop); return 2; }
    raop_set_dnssd(raop, dnssd);
    dnssd_register_raop(dnssd, port);
    dnssd_register_airplay(dnssd, port + 1);

    fprintf(stderr,
            "airplay: advertising \"%s\" (raop :%u / airplay :%u) — pick it in Control Center > Screen Mirroring\n",
            name, port, port + 1);
    fflush(stderr);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    thread_handle_t sin_thr;
    THREAD_CREATE(sin_thr, stdin_thread, NULL);

    while (!g_stop) sleepms(100);

    logmsg("airplay: shutting down");
    audio_teardown();
    dnssd_unregister_raop(dnssd);
    dnssd_unregister_airplay(dnssd);
    raop_destroy(raop);
    dnssd_destroy(dnssd);
#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
