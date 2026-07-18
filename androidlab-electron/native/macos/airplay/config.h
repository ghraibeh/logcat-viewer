// Minimal replacement for RPiPlay's CMake-generated config.h. Every macro dnssd.c
// reads (AIRPLAY_*, GLOBAL_*, RAOP_*) is already defined in dnssdint.h / global.h,
// which dnssd.c also includes — so this only needs to satisfy the `#include`.
#ifndef AIRPLAY_CONFIG_H
#define AIRPLAY_CONFIG_H
#endif
