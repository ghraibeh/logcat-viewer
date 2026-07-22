/*
 * Copyright (c) 2019 dsafa22, All Rights Reserved.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 */

#ifndef RAOP_RTP_MIRROR_H
#define RAOP_RTP_MIRROR_H

#include <stdint.h>
#include "raop.h"
#include "logger.h"
#include "raop_ntp.h"

typedef struct raop_rtp_mirror_s raop_rtp_mirror_t;
typedef struct h264codec_s h264codec_t;

raop_rtp_mirror_t *raop_rtp_mirror_init(logger_t *logger, raop_callbacks_t *callbacks, raop_ntp_t *ntp,
                                        const unsigned char *remote, int remotelen,
                                        const unsigned char *aeskey, const unsigned char *ecdh_secret);
void raop_rtp_init_mirror_aes(raop_rtp_mirror_t *raop_rtp_mirror, uint64_t streamConnectionID);
void raop_rtp_start_mirror(raop_rtp_mirror_t *raop_rtp_mirror, int use_udp, unsigned short *mirror_data_lport);

static int raop_rtp_init_mirror_sockets(raop_rtp_mirror_t *raop_rtp_mirror, int use_ipv6);

void raop_rtp_mirror_stop(raop_rtp_mirror_t *raop_rtp_mirror);
void raop_rtp_mirror_destroy(raop_rtp_mirror_t *raop_rtp_mirror);

/* AndroidLab addition: ask the active mirror thread (process-wide — one receiver per
 * process) to drop its current video TCP connection and go back to accepting. The client
 * re-establishes the stream, which always restarts with fresh SPS/PPS + an IDR — the
 * receiver-side escape hatch when the decoder is starved for a keyframe the sender will
 * never re-send on its own (the protocol has no keyframe request). Safe from any thread. */
void raop_rtp_mirror_request_nudge(void);
#endif //RAOP_RTP_MIRROR_H
