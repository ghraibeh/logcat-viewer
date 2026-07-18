/**
 * bonjour_shim.h — a self-contained mDNS/DNS-SD advertiser that implements the tiny
 * slice of Apple's dns_sd API that RPiPlay's dnssd.c actually uses, backed by the
 * vendored mjansson/mdns.h responder (vendor/mdns.h, public domain).
 *
 * Why this exists: the macOS build let dnssd.c call the system mDNSResponder; on
 * Windows/Linux that would mean shipping Apple's Bonjour SDK or requiring Avahi. This
 * shim removes that OS dependency entirely — the AirPlay receiver advertises itself on
 * every platform with no external mDNS daemon or library.
 *
 * dnssd.c reaches these through function pointers (see its USE_BUNDLED_MDNS branch),
 * casting to its own dns_sd typedefs. The ABI matches Apple's dns_sd.h for the calls
 * dnssd.c makes: DNSServiceRegister + the TXTRecord* builders.
 */
#ifndef BONJOUR_SHIM_H
#define BONJOUR_SHIM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handle returned by register; passed back to deallocate. Structurally an
 * opaque pointer, matching dns_sd.h's `typedef struct _DNSServiceRef_t *DNSServiceRef`. */
typedef struct bshim_sdref *bshim_DNSServiceRef;

/* 16-byte opaque TXT builder, byte-compatible with dns_sd.h's TXTRecordRef union. We
 * stash a heap pointer in the first sizeof(void*) bytes. */
typedef union bshim_TXTRecordRef_t {
    char PrivateData[16];
    char *ForceNaturalAlignment;
} bshim_TXTRecordRef;

typedef uint32_t bshim_DNSServiceFlags;
typedef int32_t bshim_DNSServiceErrorType;

/* --- TXT record builder (DNS-SD wire format: repeated <len><key=value>) --- */
void bshim_TXTRecordCreate(bshim_TXTRecordRef *txt, uint16_t bufferLen, void *buffer);
void bshim_TXTRecordDeallocate(bshim_TXTRecordRef *txt);
bshim_DNSServiceErrorType bshim_TXTRecordSetValue(bshim_TXTRecordRef *txt, const char *key,
                                                  uint8_t valueSize, const void *value);
uint16_t bshim_TXTRecordGetLength(const bshim_TXTRecordRef *txt);
const void *bshim_TXTRecordGetBytesPtr(const bshim_TXTRecordRef *txt);

/* --- service registration --- */
/* port is in NETWORK byte order (dnssd.c passes htons(port)), matching dns_sd.h. */
bshim_DNSServiceErrorType bshim_DNSServiceRegister(bshim_DNSServiceRef *sdRef,
                                                   bshim_DNSServiceFlags flags,
                                                   uint32_t interfaceIndex, const char *name,
                                                   const char *regtype, const char *domain,
                                                   const char *host, uint16_t port, uint16_t txtLen,
                                                   const void *txtRecord, void *callBack,
                                                   void *context);
void bshim_DNSServiceRefDeallocate(bshim_DNSServiceRef sdRef);

#ifdef __cplusplus
}
#endif

#endif /* BONJOUR_SHIM_H */
