/* Single translation unit that compiles the vendored miniaudio implementation.
 * airplayscreen.c includes miniaudio.h for declarations only; the implementation
 * lives here. We only need raw playback, so the decoders/encoders/resource-manager
 * are trimmed out to cut build time and binary size. */
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#include "miniaudio.h"
