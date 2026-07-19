/**
 * bonjour_shim.c — see bonjour_shim.h. A minimal, self-contained mDNS responder that
 * advertises the AirPlay _raop._tcp and _airplay._tcp services (with the TXT records
 * RPiPlay's dnssd.c builds) using the vendored mjansson/mdns.h. No OS Bonjour/Avahi.
 *
 * One background thread owns the mDNS sockets (UDP 5353, joined multicast on every
 * interface, SO_REUSEADDR so it coexists with a system mDNSResponder on macOS). It
 * answers PTR/SRV/TXT/A/AAAA questions for the registered services and periodically
 * emits unsolicited announcements so devices discover the receiver promptly. The
 * responder logic is adapted from mjansson/mdns's reference service example.
 */
#include "bonjour_shim.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <iphlpapi.h>
#else
#  include <sys/types.h>
#  include <sys/socket.h>
#  include <sys/select.h>
#  include <netinet/in.h>
#  include <arpa/inet.h>
#  include <net/if.h>
#  include <ifaddrs.h>
#  include <unistd.h>
#endif

#include "threads.h"
#include "mdns.h"
#include <errno.h>

/* Android-only trace to logcat (tag "airplay-mdns"): diagnoses whether the phone
 * receives iOS/Mac browse queries and whether we answer. No-op off Android. */
#ifdef __ANDROID__
#  include <android/log.h>
#  define BSHIM_LOG(...) __android_log_print(ANDROID_LOG_INFO, "airplay-mdns", __VA_ARGS__)
#else
#  define BSHIM_LOG(...) ((void)0)
#endif

#define BSHIM_MAX_SERVICES 4
#define BSHIM_MAX_TXT 48
#define BSHIM_TXT_STORAGE 2048
#define BSHIM_SENDBUF 4096

typedef struct {
    int used;
    char service[256];          /* "_raop._tcp.local." (answer target for PTR)          */
    char instance[320];         /* WIRE form: dots in <name> escaped "\." so the writer
                                   emits ONE label (SRV/TXT owner, PTR rdata)           */
    char instance_plain[320];   /* PLAIN form: for matching extracted query names
                                   (mdns_string_extract joins labels with plain dots)   */
    int goodbye;                /* >0: unregistered — send that many TTL-0 goodbye
                                   bursts from the responder thread, then free the slot */
    uint16_t port;              /* host byte order                                      */
    mdns_record_t record_ptr;   /* name=service        -> ptr.name=instance             */
    mdns_record_t record_srv;   /* name=instance       -> srv{port, name=host}          */
    mdns_record_t txt[BSHIM_MAX_TXT];
    size_t txt_count;
    char txt_storage[BSHIM_TXT_STORAGE]; /* backing "key=value\0" strings for txt[]      */
} bshim_service;

/* Growable DNS-SD TXT byte buffer, referenced from a TXTRecordRef. */
typedef struct {
    uint8_t *buf;
    uint16_t len;
    uint16_t cap;
} bshim_txtbuf;

static bshim_service g_services[BSHIM_MAX_SERVICES];
static int g_count = 0;
static mutex_handle_t g_mtx;
static int g_started = 0;              /* responder thread + host identity initialized  */
static thread_handle_t g_thread;
static volatile int g_stop = 0;
static volatile int g_announce = 0;    /* remaining gratuitous announcements to emit    */

/* Shared host identity (one A/AAAA for all services). */
static char g_host[256];               /* "<host>-mlk.local."                            */
static struct sockaddr_in g_addr4;
static struct sockaddr_in6 g_addr6;
static mdns_record_t g_record_a;
static mdns_record_t g_record_aaaa;

/* ------------------------------------------------------------------ TXT builder --- */

void bshim_TXTRecordCreate(bshim_TXTRecordRef *txt, uint16_t bufferLen, void *buffer) {
    (void)bufferLen; (void)buffer; /* we manage our own growable buffer */
    bshim_txtbuf *t = (bshim_txtbuf *)calloc(1, sizeof(*t));
    if (t) {
        t->cap = 256;
        t->buf = (uint8_t *)malloc(t->cap);
        if (!t->buf) { free(t); t = NULL; }
    }
    memset(txt, 0, sizeof(*txt));
    memcpy(txt->PrivateData, &t, sizeof(t));
}

static bshim_txtbuf *txt_of(const bshim_TXTRecordRef *txt) {
    bshim_txtbuf *t = NULL;
    memcpy(&t, txt->PrivateData, sizeof(t));
    return t;
}

bshim_DNSServiceErrorType bshim_TXTRecordSetValue(bshim_TXTRecordRef *txt, const char *key,
                                                  uint8_t valueSize, const void *value) {
    bshim_txtbuf *t = txt_of(txt);
    if (!t) return -1;
    size_t klen = strlen(key);
    size_t entry = klen + (valueSize ? (size_t)1 + valueSize : 0); /* "key" or "key=value" */
    if (entry > 255) return -1;
    size_t need = (size_t)t->len + 1 + entry;
    if (need > t->cap) {
        uint16_t ncap = t->cap;
        while (need > ncap && ncap < 0xF000) ncap = (uint16_t)(ncap * 2);
        uint8_t *nb = (uint8_t *)realloc(t->buf, ncap);
        if (!nb) return -1;
        t->buf = nb; t->cap = ncap;
    }
    t->buf[t->len++] = (uint8_t)entry;
    memcpy(t->buf + t->len, key, klen); t->len += (uint16_t)klen;
    if (valueSize) {
        t->buf[t->len++] = '=';
        memcpy(t->buf + t->len, value, valueSize); t->len += valueSize;
    }
    return 0;
}

uint16_t bshim_TXTRecordGetLength(const bshim_TXTRecordRef *txt) {
    bshim_txtbuf *t = txt_of(txt);
    return t ? t->len : 0;
}

const void *bshim_TXTRecordGetBytesPtr(const bshim_TXTRecordRef *txt) {
    bshim_txtbuf *t = txt_of(txt);
    return t ? t->buf : NULL;
}

void bshim_TXTRecordDeallocate(bshim_TXTRecordRef *txt) {
    bshim_txtbuf *t = txt_of(txt);
    if (t) { free(t->buf); free(t); }
    memset(txt, 0, sizeof(*txt));
}

/* ---------------------------------------------------------- host identity setup --- */

static void build_host_identity(void) {
    char h[128] = {0};
#ifdef _WIN32
    DWORD n = sizeof(h);
    if (!GetComputerNameA(h, &n)) strcpy(h, "mobilelabkit");
#else
    if (gethostname(h, sizeof(h) - 1) != 0) strcpy(h, "mobilelabkit");
#endif
    /* first label only, sanitized to DNS-safe chars */
    for (char *p = h; *p; ++p) {
        if (*p == '.') { *p = 0; break; }
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '-'))
            *p = '-';
    }
    if (!h[0]) strcpy(h, "mobilelabkit");
    /* "-mlk" suffix keeps our A record distinct from the machine's own <host>.local */
    snprintf(g_host, sizeof(g_host), "%s-mlk.local.", h);

    memset(&g_addr4, 0, sizeof(g_addr4));
    memset(&g_addr6, 0, sizeof(g_addr6));

#ifdef _WIN32
    ULONG sz = 16 * 1024;
    IP_ADAPTER_ADDRESSES *aa = (IP_ADAPTER_ADDRESSES *)malloc(sz);
    if (aa && GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_ANYCAST,
                                   NULL, aa, &sz) == NO_ERROR) {
        for (IP_ADAPTER_ADDRESSES *a = aa; a; a = a->Next) {
            if (a->OperStatus != IfOperStatusUp) continue;
            for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u; u = u->Next) {
                struct sockaddr *sa = u->Address.lpSockaddr;
                if (sa->sa_family == AF_INET && g_addr4.sin_family != AF_INET) {
                    struct sockaddr_in *s = (struct sockaddr_in *)sa;
                    if (s->sin_addr.S_un.S_un_b.s_b1 != 127) g_addr4 = *s;
                } else if (sa->sa_family == AF_INET6 && g_addr6.sin6_family != AF_INET6) {
                    struct sockaddr_in6 *s = (struct sockaddr_in6 *)sa;
                    if (!s->sin6_scope_id) g_addr6 = *s;
                }
            }
        }
    }
    free(aa);
#else
    struct ifaddrs *ifap = NULL;
    if (getifaddrs(&ifap) == 0) {
        for (struct ifaddrs *p = ifap; p; p = p->ifa_next) {
            if (!p->ifa_addr) continue;
            if (!(p->ifa_flags & IFF_UP) || !(p->ifa_flags & IFF_MULTICAST)) continue;
            if ((p->ifa_flags & IFF_LOOPBACK)) continue;
            if (p->ifa_addr->sa_family == AF_INET && g_addr4.sin_family != AF_INET) {
                struct sockaddr_in *s = (struct sockaddr_in *)p->ifa_addr;
                if (s->sin_addr.s_addr != htonl(INADDR_LOOPBACK)) g_addr4 = *s;
            } else if (p->ifa_addr->sa_family == AF_INET6 && g_addr6.sin6_family != AF_INET6) {
                struct sockaddr_in6 *s = (struct sockaddr_in6 *)p->ifa_addr;
                if (!s->sin6_scope_id) g_addr6 = *s;
            }
        }
        freeifaddrs(ifap);
    }
#endif

#ifdef __ANDROID__
    /* Android's gethostname() is almost always "localhost" — a guaranteed A-record
     * collision if two receivers share a LAN. Derive a unique host label from our
     * IPv4 instead (unique per LAN by definition; re-derived on every start). */
    if (g_addr4.sin_family == AF_INET) {
        const uint8_t *ip = (const uint8_t *)&g_addr4.sin_addr.s_addr;
        snprintf(g_host, sizeof(g_host), "mlk-%u-%u-%u-%u.local.", ip[0], ip[1], ip[2], ip[3]);
    }
#endif

    g_record_a.name.str = g_host;
    g_record_a.name.length = strlen(g_host);
    g_record_a.type = MDNS_RECORDTYPE_A;
    g_record_a.data.a.addr = g_addr4;
    g_record_a.rclass = 0;
    g_record_a.ttl = 0;

    g_record_aaaa.name.str = g_host;
    g_record_aaaa.name.length = strlen(g_host);
    g_record_aaaa.type = MDNS_RECORDTYPE_AAAA;
    g_record_aaaa.data.aaaa.addr = g_addr6;
    g_record_aaaa.rclass = 0;
    g_record_aaaa.ttl = 0;
}

/* Assemble the additional records (SRV + A/AAAA + all TXT k/v) for a service answer. */
static size_t build_additional(const bshim_service *s, int include_srv, mdns_record_t *out,
                               size_t cap) {
    size_t n = 0;
    if (include_srv && n < cap) out[n++] = s->record_srv;
    if (g_addr4.sin_family == AF_INET && n < cap) out[n++] = g_record_a;
    if (g_addr6.sin6_family == AF_INET6 && n < cap) out[n++] = g_record_aaaa;
    for (size_t i = 0; i < s->txt_count && n < cap; ++i) out[n++] = s->txt[i];
    return n;
}

/* -------------------------------------------------------------- responder thread --- */

static uint8_t g_sendbuf[BSHIM_SENDBUF];

static int responder_cb(int sock, const struct sockaddr *from, size_t addrlen,
                        mdns_entry_type_t entry, uint16_t query_id, uint16_t rtype,
                        uint16_t rclass, uint32_t ttl, const void *data, size_t size,
                        size_t name_offset, size_t name_length, size_t record_offset,
                        size_t record_length, void *user_data) {
    (void)ttl; (void)name_length; (void)record_offset; (void)record_length; (void)user_data;
    if (entry != MDNS_ENTRYTYPE_QUESTION) return 0;

    static const char DNS_SD[] = "_services._dns-sd._udp.local.";
    char namebuf[256];
    size_t offset = name_offset;
    mdns_string_t name = mdns_string_extract(data, size, &offset, namebuf, sizeof(namebuf));
    uint16_t unicast = (uint16_t)(rclass & MDNS_UNICAST_RESPONSE);
    mdns_record_t additional[BSHIM_MAX_TXT + 4];

    MUTEX_LOCK(g_mtx);

    /* Meta-query: enumerate the service types we host. */
    if (name.length == sizeof(DNS_SD) - 1 && strncmp(name.str, DNS_SD, name.length) == 0 &&
        (rtype == MDNS_RECORDTYPE_PTR || rtype == MDNS_RECORDTYPE_ANY)) {
        for (int i = 0; i < BSHIM_MAX_SERVICES; ++i) {
            if (!g_services[i].used) continue;
            mdns_record_t ans;
            memset(&ans, 0, sizeof(ans));
            ans.name = name;
            ans.type = MDNS_RECORDTYPE_PTR;
            ans.data.ptr.name.str = g_services[i].service;
            ans.data.ptr.name.length = strlen(g_services[i].service);
            if (unicast)
                mdns_query_answer_unicast(sock, from, addrlen, g_sendbuf, sizeof(g_sendbuf),
                                          query_id, rtype, name.str, name.length, ans, 0, 0, 0, 0);
            else
                mdns_query_answer_multicast(sock, g_sendbuf, sizeof(g_sendbuf), ans, 0, 0, 0, 0);
        }
        MUTEX_UNLOCK(g_mtx);
        return 0;
    }

    for (int i = 0; i < BSHIM_MAX_SERVICES; ++i) {
        bshim_service *s = &g_services[i];
        if (!s->used) continue;
        /* Instance queries arrive as wire labels; extraction joins them with plain
         * dots — so match against instance_plain (not the escaped wire form). */
        size_t slen = strlen(s->service), ilen = strlen(s->instance_plain), hlen = strlen(g_host);

        if (name.length == slen && strncmp(name.str, s->service, slen) == 0 &&
            (rtype == MDNS_RECORDTYPE_PTR || rtype == MDNS_RECORDTYPE_ANY)) {
            /* PTR for the service type -> instance, plus SRV/A/AAAA/TXT. */
            mdns_record_t ans = s->record_ptr;
            size_t na = build_additional(s, 1, additional, sizeof(additional) / sizeof(additional[0]));
            if (unicast)
                mdns_query_answer_unicast(sock, from, addrlen, g_sendbuf, sizeof(g_sendbuf),
                                          query_id, rtype, name.str, name.length, ans, 0, 0,
                                          additional, na);
            else
                mdns_query_answer_multicast(sock, g_sendbuf, sizeof(g_sendbuf), ans, 0, 0,
                                            additional, na);
        } else if (name.length == ilen && strncmp(name.str, s->instance_plain, ilen) == 0 &&
                   (rtype == MDNS_RECORDTYPE_SRV || rtype == MDNS_RECORDTYPE_TXT ||
                    rtype == MDNS_RECORDTYPE_ANY)) {
            /* SRV/TXT for the instance -> SRV answer + A/AAAA/TXT additional. The
             * unicast answer echoes the question; pass the ESCAPED form so the echoed
             * qname re-encodes to the same single-label wire name the querier sent. */
            mdns_record_t ans = s->record_srv;
            size_t na = build_additional(s, 0, additional, sizeof(additional) / sizeof(additional[0]));
            if (unicast)
                mdns_query_answer_unicast(sock, from, addrlen, g_sendbuf, sizeof(g_sendbuf),
                                          query_id, rtype, s->instance, strlen(s->instance), ans, 0, 0,
                                          additional, na);
            else
                mdns_query_answer_multicast(sock, g_sendbuf, sizeof(g_sendbuf), ans, 0, 0,
                                            additional, na);
        } else if (name.length == hlen && strncmp(name.str, g_host, hlen) == 0 &&
                   (rtype == MDNS_RECORDTYPE_A || rtype == MDNS_RECORDTYPE_AAAA ||
                    rtype == MDNS_RECORDTYPE_ANY)) {
            /* A/AAAA for our host name. */
            if (g_addr4.sin_family == AF_INET &&
                (rtype == MDNS_RECORDTYPE_A || rtype == MDNS_RECORDTYPE_ANY)) {
                mdns_record_t ans = g_record_a;
                if (unicast)
                    mdns_query_answer_unicast(sock, from, addrlen, g_sendbuf, sizeof(g_sendbuf),
                                              query_id, rtype, name.str, name.length, ans, 0, 0, 0, 0);
                else
                    mdns_query_answer_multicast(sock, g_sendbuf, sizeof(g_sendbuf), ans, 0, 0, 0, 0);
            }
            if (g_addr6.sin6_family == AF_INET6 &&
                (rtype == MDNS_RECORDTYPE_AAAA || rtype == MDNS_RECORDTYPE_ANY)) {
                mdns_record_t ans = g_record_aaaa;
                if (unicast)
                    mdns_query_answer_unicast(sock, from, addrlen, g_sendbuf, sizeof(g_sendbuf),
                                              query_id, rtype, name.str, name.length, ans, 0, 0, 0, 0);
                else
                    mdns_query_answer_multicast(sock, g_sendbuf, sizeof(g_sendbuf), ans, 0, 0, 0, 0);
            }
        }
    }
    MUTEX_UNLOCK(g_mtx);
    return 0;
}

static int open_sockets(int *socks, int max) {
    int n = 0;
    if (n < max) {
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof(sa));
        sa.sin_family = AF_INET;
        sa.sin_addr.s_addr = INADDR_ANY;
#ifdef __ANDROID__
        /* Android does NOT egress/join multicast on wlan0 for INADDR_ANY — the kernel's
         * default multicast route isn't the Wi-Fi interface, so our announcements never
         * reach the iPhone. Pin the discovered LAN IPv4 (g_addr4) so mdns.h sets
         * IP_MULTICAST_IF + imr_interface to wlan0. It still bind()s the socket to
         * INADDR_ANY, so inbound query RX is unaffected. (Gated to Android; the desktop
         * path — verified working — is left byte-for-byte unchanged.) */
        if (g_addr4.sin_family == AF_INET) sa.sin_addr = g_addr4.sin_addr;
#endif
        sa.sin_port = htons(MDNS_PORT);
#ifdef __APPLE__
        sa.sin_len = sizeof(sa);
#endif
        int s = mdns_socket_open_ipv4(&sa);
        if (s >= 0) {
            /* RFC 6762 §11: mDNS packets MUST go out with IP TTL 255. mdns.h sets TTL=1,
             * which Apple's mDNSResponder (and iOS) silently DROP as off-link — so the
             * receiver was invisible cross-network despite valid packets arriving. */
            unsigned char ttl = 255;
            setsockopt(s, IPPROTO_IP, IP_MULTICAST_TTL, (const char *)&ttl, sizeof(ttl));
            socks[n++] = s;
        }
    }
    if (n < max) {
        struct sockaddr_in6 sa;
        memset(&sa, 0, sizeof(sa));
        sa.sin6_family = AF_INET6;
        sa.sin6_addr = in6addr_any;
        sa.sin6_port = htons(MDNS_PORT);
#ifdef __APPLE__
        sa.sin6_len = sizeof(sa);
#endif
        int s = mdns_socket_open_ipv6(&sa);
        if (s >= 0) socks[n++] = s;
    }
    return n;
}

static void announce_all(int *socks, int nsock) {
    mdns_record_t additional[BSHIM_MAX_TXT + 4];
    MUTEX_LOCK(g_mtx);
    for (int i = 0; i < BSHIM_MAX_SERVICES; ++i) {
        bshim_service *s = &g_services[i];
        if (!s->used) continue;
        size_t na = build_additional(s, 1, additional, sizeof(additional) / sizeof(additional[0]));
        for (int k = 0; k < nsock; ++k) {
            errno = 0;
            int r = mdns_announce_multicast(socks[k], g_sendbuf, sizeof(g_sendbuf), s->record_ptr,
                                            0, 0, additional, na);
            if (r < 0) BSHIM_LOG("announce %s sock[%d] FAILED errno=%d", s->service, k, errno);
        }
    }
    MUTEX_UNLOCK(g_mtx);
}

/* Send TTL-0 "goodbye" announcements for unregistered services so peers drop the
 * cached name at once (instead of showing a stale entry until the record TTL runs
 * out — e.g. in the iPhone's Screen Mirroring list). Frees the slot when done. */
static void goodbye_flush(int *socks, int nsock) {
    mdns_record_t additional[BSHIM_MAX_TXT + 4];
    MUTEX_LOCK(g_mtx);
    for (int i = 0; i < BSHIM_MAX_SERVICES; ++i) {
        bshim_service *s = &g_services[i];
        if (!s->used || s->goodbye <= 0) continue;
        size_t na = build_additional(s, 1, additional, sizeof(additional) / sizeof(additional[0]));
        for (int k = 0; k < nsock; ++k)
            mdns_goodbye_multicast(socks[k], g_sendbuf, sizeof(g_sendbuf), s->record_ptr, 0, 0,
                                   additional, na);
        if (--s->goodbye == 0) s->used = 0;
    }
    MUTEX_UNLOCK(g_mtx);
}

static THREAD_RETVAL responder_thread(void *arg) {
    (void)arg;
    int socks[8];
    int nsock = open_sockets(socks, 8);
    if (nsock <= 0) {
        fprintf(stderr, "bonjour_shim: could not open mDNS sockets\n");
        return (THREAD_RETVAL)0;
    }
    BSHIM_LOG("responder up: %d socket(s), mcast-if=%s", nsock,
              g_addr4.sin_family == AF_INET ? inet_ntoa(g_addr4.sin_addr) : "ANY");
    static uint8_t rbuf[2048];
    while (!g_stop) {
        if (g_announce > 0) { announce_all(socks, nsock); g_announce--; }
        goodbye_flush(socks, nsock);
        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 250000;
        fd_set fds;
        FD_ZERO(&fds);
        int maxfd = 0;
        for (int i = 0; i < nsock; ++i) {
            FD_SET(socks[i], &fds);
            if (socks[i] > maxfd) maxfd = socks[i];
        }
        if (select(maxfd + 1, &fds, NULL, NULL, &tv) > 0) {
            for (int i = 0; i < nsock; ++i)
                if (FD_ISSET(socks[i], &fds))
                    mdns_socket_listen(socks[i], rbuf, sizeof(rbuf), responder_cb, NULL);
        }
    }
    for (int i = 0; i < nsock; ++i) mdns_socket_close(socks[i]);
    return (THREAD_RETVAL)0;
}

/* ------------------------------------------------------------------ registration --- */

bshim_DNSServiceErrorType bshim_DNSServiceRegister(bshim_DNSServiceRef *sdRef,
                                                   bshim_DNSServiceFlags flags,
                                                   uint32_t interfaceIndex, const char *name,
                                                   const char *regtype, const char *domain,
                                                   const char *host, uint16_t port, uint16_t txtLen,
                                                   const void *txtRecord, void *callBack,
                                                   void *context) {
    (void)flags; (void)interfaceIndex; (void)domain; (void)host; (void)callBack; (void)context;
    if (!g_started) {
        MUTEX_CREATE(g_mtx);
        build_host_identity();
        g_started = 1;
    }

    MUTEX_LOCK(g_mtx);
    int slot = -1;
    for (int i = 0; i < BSHIM_MAX_SERVICES; ++i)
        if (!g_services[i].used) { slot = i; break; }
    if (slot < 0) { MUTEX_UNLOCK(g_mtx); return -1; }

    bshim_service *s = &g_services[slot];
    memset(s, 0, sizeof(*s));
    s->port = ntohs(port); /* dns_sd passes network order; SRV wants host order */
    snprintf(s->service, sizeof(s->service), "%s.local.", regtype);
    /* PLAIN form for matching inbound queries (extraction joins labels with dots)… */
    snprintf(s->instance_plain, sizeof(s->instance_plain), "%s.%s.local.", name, regtype);
    /* …and WIRE form for record fields: escape literal dots/backslashes in the
     * instance so mdns_string_make emits it as ONE label (RFC 6763 §4.3 — instance
     * names like "MobileLabKit.android" are a single label; unescaped, the name
     * splits into a bogus subdomain and Apple's resolver silently drops it). */
    char esc[288];
    size_t eo = 0;
    for (const char *p = name; *p && eo < sizeof(esc) - 2; ++p) {
        if (*p == '.' || *p == '\\') esc[eo++] = '\\';
        esc[eo++] = *p;
    }
    esc[eo] = 0;
    snprintf(s->instance, sizeof(s->instance), "%s.%s.local.", esc, regtype);

    s->record_ptr.name.str = s->service;
    s->record_ptr.name.length = strlen(s->service);
    s->record_ptr.type = MDNS_RECORDTYPE_PTR;
    s->record_ptr.data.ptr.name.str = s->instance;
    s->record_ptr.data.ptr.name.length = strlen(s->instance);

    s->record_srv.name.str = s->instance;
    s->record_srv.name.length = strlen(s->instance);
    s->record_srv.type = MDNS_RECORDTYPE_SRV;
    s->record_srv.data.srv.priority = 0;
    s->record_srv.data.srv.weight = 0;
    s->record_srv.data.srv.port = s->port;
    s->record_srv.data.srv.name.str = g_host;
    s->record_srv.data.srv.name.length = strlen(g_host);

    /* Parse the DNS-SD TXT blob (repeated <len><key=value>) into per-pair records,
     * copying the key/value bytes into txt_storage so the mdns_string_t's stay valid. */
    const uint8_t *tb = (const uint8_t *)txtRecord;
    size_t off = 0, store = 0;
    while (txtRecord && off < txtLen && s->txt_count < BSHIM_MAX_TXT) {
        uint8_t elen = tb[off++];
        if (off + elen > txtLen) break;
        const uint8_t *entry = tb + off;
        off += elen;
        /* split on the first '=' */
        size_t eq = 0;
        while (eq < elen && entry[eq] != '=') eq++;
        size_t klen = eq, vlen = (eq < elen) ? (elen - eq - 1) : 0;
        if (store + klen + vlen + 2 > sizeof(s->txt_storage)) break;
        char *kp = s->txt_storage + store;
        memcpy(kp, entry, klen); kp[klen] = 0; store += klen + 1;
        char *vp = s->txt_storage + store;
        if (vlen) memcpy(vp, entry + eq + 1, vlen);
        vp[vlen] = 0; store += vlen + 1;

        mdns_record_t *r = &s->txt[s->txt_count++];
        memset(r, 0, sizeof(*r));
        r->name.str = s->instance;
        r->name.length = strlen(s->instance);
        r->type = MDNS_RECORDTYPE_TXT;
        r->data.txt.key.str = kp;
        r->data.txt.key.length = klen;
        r->data.txt.value.str = vp;
        r->data.txt.value.length = vlen;
    }

    s->used = 1;
    g_count++;
    g_announce = 4; /* gratuitous announcements over the next ~1s */
    MUTEX_UNLOCK(g_mtx);

    if (sdRef) *sdRef = (bshim_DNSServiceRef)(intptr_t)(slot + 1);

    if (!g_thread) { THREAD_CREATE(g_thread, responder_thread, NULL); }
    return 0;
}

void bshim_DNSServiceRefDeallocate(bshim_DNSServiceRef sdRef) {
    int slot = (int)(intptr_t)sdRef - 1;
    if (slot < 0 || slot >= BSHIM_MAX_SERVICES) return;
    MUTEX_LOCK(g_mtx);
    if (g_services[slot].used) {
        g_services[slot].goodbye = 2; /* responder thread sends TTL-0 goodbyes, then frees */
        if (g_count > 0) g_count--;
    }
    int remaining = g_count;
    MUTEX_UNLOCK(g_mtx);
    /* When the last service goes away, give the thread a beat to flush the goodbye
     * bursts (its loop ticks every 250 ms), then stop it. */
    if (remaining == 0 && g_thread) {
        for (int i = 0; i < 12; ++i) {
            MUTEX_LOCK(g_mtx);
            int pending = g_services[slot].used;
            MUTEX_UNLOCK(g_mtx);
            if (!pending) break;
            sleepms(60);
        }
        g_stop = 1;
        THREAD_JOIN(g_thread);
        g_thread = 0;
        g_stop = 0;
    }
}
