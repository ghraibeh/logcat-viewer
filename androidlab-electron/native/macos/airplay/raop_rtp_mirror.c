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

#include "raop_rtp_mirror.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <netinet/tcp.h>

#include "raop.h"
#include "netutils.h"
#include "compat.h"
#include "logger.h"
#include "byteutils.h"
#include "mirror_buffer.h"
#include "stream.h"


struct h264codec_s {
    unsigned char compatibility;
    short pps_size;
    short sps_size;
    unsigned char level;
    unsigned char number_of_pps;
    unsigned char* picture_parameter_set;
    unsigned char profile_high;
    unsigned char reserved_3_and_sps;
    unsigned char reserved_6_and_nal;
    unsigned char* sequence_parameter_set;
    unsigned char version;
};

struct raop_rtp_mirror_s {
    logger_t *logger;
    raop_callbacks_t callbacks;
    raop_ntp_t *ntp;

    /* Buffer to handle all resends */
    mirror_buffer_t *buffer;

    /* Remote address as sockaddr */
    struct sockaddr_storage remote_saddr;
    socklen_t remote_saddr_len;

    /* MUTEX LOCKED VARIABLES START */
    /* These variables only edited mutex locked */
    int running;
    int joined;

    int flush;
    thread_handle_t thread_mirror;
    mutex_handle_t run_mutex;

    /* MUTEX LOCKED VARIABLES END */
    int mirror_data_sock;

    unsigned short mirror_data_lport;
};

static int
raop_rtp_parse_remote(raop_rtp_mirror_t *raop_rtp_mirror, const unsigned char *remote, int remotelen)
{
    char current[25];
    int family;
    int ret;
    assert(raop_rtp_mirror);
    if (remotelen == 4) {
        family = AF_INET;
    } else if (remotelen == 16) {
        family = AF_INET6;
    } else {
        return -1;
    }
    memset(current, 0, sizeof(current));
    sprintf(current, "%d.%d.%d.%d", remote[0], remote[1], remote[2], remote[3]);
    logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror parse remote ip = %s", current);
    ret = netutils_parse_address(family, current,
                                 &raop_rtp_mirror->remote_saddr,
                                 sizeof(raop_rtp_mirror->remote_saddr));
    if (ret < 0) {
        return -1;
    }
    raop_rtp_mirror->remote_saddr_len = ret;
    return 0;
}

#define NO_FLUSH (-42)
raop_rtp_mirror_t *raop_rtp_mirror_init(logger_t *logger, raop_callbacks_t *callbacks, raop_ntp_t *ntp,
                                        const unsigned char *remote, int remotelen,
                                        const unsigned char *aeskey, const unsigned char *ecdh_secret)
{
    raop_rtp_mirror_t *raop_rtp_mirror;

    assert(logger);
    assert(callbacks);

    raop_rtp_mirror = calloc(1, sizeof(raop_rtp_mirror_t));
    if (!raop_rtp_mirror) {
        return NULL;
    }
    raop_rtp_mirror->logger = logger;
    raop_rtp_mirror->ntp = ntp;

    memcpy(&raop_rtp_mirror->callbacks, callbacks, sizeof(raop_callbacks_t));
    raop_rtp_mirror->buffer = mirror_buffer_init(logger, aeskey, ecdh_secret);
    if (!raop_rtp_mirror->buffer) {
        free(raop_rtp_mirror);
        return NULL;
    }
    if (raop_rtp_parse_remote(raop_rtp_mirror, remote, remotelen) < 0) {
        free(raop_rtp_mirror);
        return NULL;
    }
    raop_rtp_mirror->running = 0;
    raop_rtp_mirror->joined = 1;
    raop_rtp_mirror->flush = NO_FLUSH;

    MUTEX_CREATE(raop_rtp_mirror->run_mutex);
    return raop_rtp_mirror;
}

void
raop_rtp_init_mirror_aes(raop_rtp_mirror_t *raop_rtp_mirror, uint64_t streamConnectionID)
{
    mirror_buffer_init_aes(raop_rtp_mirror->buffer, streamConnectionID);
}

//#define DUMP_H264

#define RAOP_PACKET_LEN 32768
// AndroidLab edit: sanity ceiling for the 4-byte payload_size read off the wire. Without
// this, a torn/misaligned TCP read (more likely under the higher packet rate a
// fast-scrolling mirror produces) can hand back a garbage length — including negative
// values that reinterpret as multi-gigabyte mallocs — which previously went straight into
// malloc() with no validation at all.
#define MIRROR_MAX_PAYLOAD (16 * 1024 * 1024)
/**
 * Mirror
 */
static THREAD_RETVAL
raop_rtp_mirror_thread(void *arg)
{
    raop_rtp_mirror_t *raop_rtp_mirror = arg;
    assert(raop_rtp_mirror);

    int stream_fd = -1;
    unsigned char packet[128];
    memset(packet, 0 , 128);
    unsigned char* payload = NULL;
    unsigned int readstart = 0;

#ifdef DUMP_H264
    // C decrypted
    FILE* file = fopen("/home/pi/Airplay.h264", "wb");
    // Encrypted source file
    FILE* file_source = fopen("/home/pi/Airplay.source", "wb");
    FILE* file_len = fopen("/home/pi/Airplay.len", "wb");
#endif

    while (1) {
        fd_set rfds;
        struct timeval tv;
        int nfds, ret;
        MUTEX_LOCK(raop_rtp_mirror->run_mutex);
        if (!raop_rtp_mirror->running) {
            MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
            break;
        }
        MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);

        /* Set timeout value to 5ms */
        tv.tv_sec = 0;
        tv.tv_usec = 5000;

        /* Get the correct nfds value and set rfds */
        FD_ZERO(&rfds);
        if (stream_fd == -1) {
            FD_SET(raop_rtp_mirror->mirror_data_sock, &rfds);
            nfds = raop_rtp_mirror->mirror_data_sock+1;
        } else {
            FD_SET(stream_fd, &rfds);
            nfds = stream_fd+1;
        }
        ret = select(nfds, &rfds, NULL, NULL, &tv);
        if (ret == 0) {
            /* Timeout happened */
            continue;
        } else if (ret == -1) {
            logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror error in select");
            break;
        }

        if (stream_fd == -1 && FD_ISSET(raop_rtp_mirror->mirror_data_sock, &rfds)) {
            struct sockaddr_storage saddr;
            socklen_t saddrlen;

            logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror accepting client");
            saddrlen = sizeof(saddr);
            stream_fd = accept(raop_rtp_mirror->mirror_data_sock, (struct sockaddr *)&saddr, &saddrlen);
            if (stream_fd == -1) {
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror error in accept %d %s", errno, strerror(errno));
                break;
            }

            // We're calling recv for a certain amount of data, so we need a timeout
            struct timeval tv;
            tv.tv_sec = 0;
            tv.tv_usec = 5000;
            if (setsockopt(stream_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) < 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror could not set stream socket timeout %d %s", errno, strerror(errno));
                break;
            }
            int option;
            option = 1;
            if (setsockopt(stream_fd, SOL_SOCKET, SO_KEEPALIVE, &option, sizeof(option)) < 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_WARNING, "raop_rtp_mirror could not set stream socket keepalive %d %s", errno, strerror(errno));
            }
            option = 60;
            if (setsockopt(stream_fd, SOL_TCP, TCP_KEEPIDLE, &option, sizeof(option)) < 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_WARNING, "raop_rtp_mirror could not set stream socket keepalive time %d %s", errno, strerror(errno));
            }
            option = 10;
            if (setsockopt(stream_fd, SOL_TCP, TCP_KEEPINTVL, &option, sizeof(option)) < 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_WARNING, "raop_rtp_mirror could not set stream socket keepalive interval %d %s", errno, strerror(errno));
            }
            option = 6;
            if (setsockopt(stream_fd, SOL_TCP, TCP_KEEPCNT, &option, sizeof(option)) < 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_WARNING, "raop_rtp_mirror could not set stream socket keepalive probes %d %s", errno, strerror(errno));
            }
            readstart = 0;
        }

        if (stream_fd != -1 && FD_ISSET(stream_fd, &rfds)) {

            // The first 128 bytes are some kind of header for the payload that follows
            while (payload == NULL && readstart < 128) {
                ret = recv(stream_fd, packet + readstart, 128 - readstart, 0);
                if (ret <= 0) break;
                readstart = readstart + ret;
            }

            if (payload == NULL && ret == 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror tcp socket closed");
                FD_CLR(stream_fd, &rfds);
                stream_fd = -1;
                continue;
            } else if (payload == NULL && ret == -1) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) continue; // Timeouts can happen even if the connection is fine
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror error in header recv: %d", errno);
                break;
            }

            int payload_size = byteutils_get_int(packet, 0);
            unsigned short payload_type = byteutils_get_short(packet, 4) & 0xff;
            unsigned short payload_option = byteutils_get_short(packet, 6);

            // AndroidLab edit: the framing gives no way to relocate the next real header
            // once a length prefix is bogus, so the only safe move is to drop this
            // connection and let the client reconnect cleanly.
            if (payload_size <= 0 || payload_size > MIRROR_MAX_PAYLOAD) {
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR,
                           "raop_rtp_mirror bogus payload_size %d — resetting stream", payload_size);
                break;
            }

            if (payload == NULL) {
                payload = malloc(payload_size);
                readstart = 0;
            }

            while (readstart < payload_size) {
                // Payload data
                ret = recv(stream_fd, payload + readstart, payload_size - readstart, 0);
                if (ret <= 0) break;
                readstart = readstart + ret;
            }

            if (ret == 0) {
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror tcp socket closed");
                break;
            } else if (ret == -1) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) continue; // Timeouts can happen even if the connection is fine
                logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror error in recv: %d", errno);
                break;
            }

            if (payload_type == 0) {
                // Normal video data (VCL NAL)

                // Conveniently, the video data is already stamped with the remote wall clock time,
                // so no additional clock syncing needed. The only thing odd here is that the video
                // ntp time stamps don't include the SECONDS_FROM_1900_TO_1970, so it's really just
                // counting micro seconds since last boot.
                uint64_t ntp_timestamp_raw = byteutils_get_long(packet, 8);
                uint64_t ntp_timestamp_remote = raop_ntp_timestamp_to_micro_seconds(ntp_timestamp_raw, false);
                uint64_t ntp_timestamp = raop_ntp_convert_remote_time(raop_rtp_mirror->ntp, ntp_timestamp_remote);

                uint64_t ntp_now = raop_ntp_get_local_time(raop_rtp_mirror->ntp);
                logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror video ntp = %llu, now = %llu, latency = %lld",
                           ntp_timestamp, ntp_now, ((int64_t) ntp_now) - ((int64_t) ntp_timestamp));

#ifdef DUMP_H264
                fwrite(payload, payload_size, 1, file_source);
                fwrite(&readstart, sizeof(readstart), 1, file_len);
#endif

                // Decrypt data
                unsigned char* payload_decrypted = malloc(payload_size);
                mirror_buffer_decrypt(raop_rtp_mirror->buffer, payload, payload_decrypted, payload_size);

                int nalu_type = payload[4] & 0x1f;
                int nalu_size = 0;
                int nalus_count = 0;
                // AndroidLab edit: the length-prefix parse below used to trust `nc_len`
                // with only an `assert` (compiled out in NDEBUG/release builds) — a
                // malformed value either spun forever or walked the read/write past the
                // end of payload_decrypted, corrupting decoder input. That's exactly the
                // failure mode reported as "blocky/broken video while scrolling": faster
                // motion means a higher packet rate, which is when a torn read is most
                // likely to hand back a bad length. Now any malformed length just drops
                // this one frame (decoder holds the last good frame — see VideoDecoder.kt's
                // awaitingIdr) instead of corrupting memory or the bitstream.
                bool nalu_malformed = false;

                // It seems the AirPlay protocol prepends NALs with their size, which we're replacing with the 4-byte
                // start code for the NAL Byte-Stream Format.
                while (nalu_size + 4 <= payload_size) {
                    int nc_len = (payload_decrypted[nalu_size + 0] << 24) | (payload_decrypted[nalu_size + 1] << 16) |
                                 (payload_decrypted[nalu_size + 2] << 8) | (payload_decrypted[nalu_size + 3]);
                    if (nc_len <= 0 || nalu_size + 4 + nc_len > payload_size) {
                        logger_log(raop_rtp_mirror->logger, LOGGER_ERR,
                                   "raop_rtp_mirror malformed NAL length %d at offset %d/%d — dropping frame",
                                   nc_len, nalu_size, payload_size);
                        nalu_malformed = true;
                        break;
                    }

                    payload_decrypted[nalu_size + 0] = 0;
                    payload_decrypted[nalu_size + 1] = 0;
                    payload_decrypted[nalu_size + 2] = 0;
                    payload_decrypted[nalu_size + 3] = 1;
                    nalu_size += nc_len + 4;
                    nalus_count++;
                }

                // logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "nalutype = %d", nalu_type);
                // logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "nalu_size = %d, payloadsize = %d nalus_count = %d",
                //        nalu_size, payload_size, nalus_count);

#ifdef DUMP_H264
                fwrite(payload_decrypted, payload_size, 1, file);
#endif

                if (!nalu_malformed) {
                    h264_decode_struct h264_data;
                    h264_data.data_len = payload_size;
                    h264_data.data = payload_decrypted;
                    h264_data.frame_type = 1;
                    h264_data.pts = ntp_timestamp;

                    raop_rtp_mirror->callbacks.video_process(raop_rtp_mirror->callbacks.cls, raop_rtp_mirror->ntp, &h264_data);
                }
                free(payload_decrypted);

            } else if ((payload_type & 255) == 1) {
                // The information in the payload contains an SPS and a PPS NAL

                float width_source = byteutils_get_float(packet, 40);
                float height_source = byteutils_get_float(packet, 44);
                float width = byteutils_get_float(packet, 56);
                float height = byteutils_get_float(packet, 60);
                logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror width_source = %f height_source = %f width = %f height = %f",
                           width_source, height_source, width, height);

                // The sps_pps is not encrypted
                h264codec_t h264;
                h264.sequence_parameter_set = NULL;
                h264.picture_parameter_set = NULL;
                // AndroidLab edit: same class of bug as the video-NAL path above — sps_size/
                // pps_size come straight off the wire and previously fed memcpy() with no
                // check against payload_size at all. Bound each read before trusting it,
                // and drop the config packet instead of reading/copying past the buffer.
                bool config_valid = payload_size >= 8;
                if (config_valid) {
                    h264.version = payload[0];
                    h264.profile_high = payload[1];
                    h264.compatibility = payload[2];
                    h264.level = payload[3];
                    h264.reserved_6_and_nal = payload[4];
                    h264.reserved_3_and_sps = payload[5];
                    h264.sps_size = (short) (((payload[6] & 255) << 8) + (payload[7] & 255));
                    config_valid = h264.sps_size >= 0 && 8 + h264.sps_size + 3 <= payload_size;
                }
                if (config_valid) {
                    logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror sps size = %d", h264.sps_size);
                    h264.sequence_parameter_set = malloc(h264.sps_size);
                    memcpy(h264.sequence_parameter_set, payload + 8, h264.sps_size);
                    h264.number_of_pps = payload[h264.sps_size + 8];
                    h264.pps_size = (short) (((payload[h264.sps_size + 9] & 2040) + payload[h264.sps_size + 10]) & 255);
                    config_valid = h264.pps_size >= 0 && h264.sps_size + 11 + h264.pps_size <= payload_size;
                }
                if (config_valid) {
                    h264.picture_parameter_set = malloc(h264.pps_size);
                    logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror pps size = %d", h264.pps_size);
                    memcpy(h264.picture_parameter_set, payload + h264.sps_size + 11, h264.pps_size);
                } else {
                    logger_log(raop_rtp_mirror->logger, LOGGER_ERR,
                               "raop_rtp_mirror malformed SPS/PPS header (payload %d bytes) — dropping config packet",
                               payload_size);
                }

                if (config_valid && h264.sps_size + h264.pps_size < 102400) {
                    // Copy the sps and pps into a buffer to hand to the decoder
                    int sps_pps_len = (h264.sps_size + h264.pps_size) + 8;
                    unsigned char sps_pps[sps_pps_len];
                    sps_pps[0] = 0;
                    sps_pps[1] = 0;
                    sps_pps[2] = 0;
                    sps_pps[3] = 1;
                    memcpy(sps_pps + 4, h264.sequence_parameter_set, h264.sps_size);
                    sps_pps[h264.sps_size + 4] = 0;
                    sps_pps[h264.sps_size + 5] = 0;
                    sps_pps[h264.sps_size + 6] = 0;
                    sps_pps[h264.sps_size + 7] = 1;
                    memcpy(sps_pps + h264.sps_size + 8, h264.picture_parameter_set, h264.pps_size);

#ifdef DUMP_H264
                    fwrite(sps_pps, sps_pps_len, 1, file);
#endif

                    h264_decode_struct h264_data;
                    h264_data.data_len = sps_pps_len;
                    h264_data.data = sps_pps;
                    h264_data.frame_type = 0;
                    h264_data.pts = 0;
                    raop_rtp_mirror->callbacks.video_process(raop_rtp_mirror->callbacks.cls, raop_rtp_mirror->ntp, &h264_data);
                }
                free(h264.picture_parameter_set);
                free(h264.sequence_parameter_set);
            }

            free(payload);
            payload = NULL;
            memset(packet, 0, 128);
            readstart = 0;
        }
    }

    /* Close the stream file descriptor */
    if (stream_fd != -1) {
        closesocket(stream_fd);
    }

#ifdef DUMP_H264
        fclose(file);
    fclose(file_source);
    fclose(file_len);
#endif

    // Ensure running reflects the actual state
    MUTEX_LOCK(raop_rtp_mirror->run_mutex);
    raop_rtp_mirror->running = false;
    MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);

    logger_log(raop_rtp_mirror->logger, LOGGER_DEBUG, "raop_rtp_mirror exiting TCP thread");

    return 0;
}

void
raop_rtp_start_mirror(raop_rtp_mirror_t *raop_rtp_mirror, int use_udp, unsigned short *mirror_data_lport)
{
    logger_log(raop_rtp_mirror->logger, LOGGER_INFO, "raop_rtp_mirror starting mirroring");
    int use_ipv6 = 0;

    assert(raop_rtp_mirror);

    MUTEX_LOCK(raop_rtp_mirror->run_mutex);
    if (raop_rtp_mirror->running || !raop_rtp_mirror->joined) {
        MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
        return;
    }

    if (raop_rtp_mirror->remote_saddr.ss_family == AF_INET6) {
        use_ipv6 = 1;
    }
    use_ipv6 = 0;
    if (raop_rtp_init_mirror_sockets(raop_rtp_mirror, use_ipv6) < 0) {
        logger_log(raop_rtp_mirror->logger, LOGGER_ERR, "raop_rtp_mirror initializing sockets failed");
        MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
        return;
    }
    if (mirror_data_lport) *mirror_data_lport = raop_rtp_mirror->mirror_data_lport;

    /* Create the thread and initialize running values */
    raop_rtp_mirror->running = 1;
    raop_rtp_mirror->joined = 0;

    THREAD_CREATE(raop_rtp_mirror->thread_mirror, raop_rtp_mirror_thread, raop_rtp_mirror);
    MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
}

void raop_rtp_mirror_stop(raop_rtp_mirror_t *raop_rtp_mirror) {
    assert(raop_rtp_mirror);

    /* Check that we are running and thread is not
     * joined (should never be while still running) */
    MUTEX_LOCK(raop_rtp_mirror->run_mutex);
    if (!raop_rtp_mirror->running || raop_rtp_mirror->joined) {
        MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
        return;
    }
    raop_rtp_mirror->running = 0;
    MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);

    if (raop_rtp_mirror->mirror_data_sock != -1) {
        closesocket(raop_rtp_mirror->mirror_data_sock);
        raop_rtp_mirror->mirror_data_sock = -1;
    }

    /* Join the thread */
    THREAD_JOIN(raop_rtp_mirror->thread_mirror);

    /* Mark thread as joined */
    MUTEX_LOCK(raop_rtp_mirror->run_mutex);
    raop_rtp_mirror->joined = 1;
    MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
}

void raop_rtp_mirror_destroy(raop_rtp_mirror_t *raop_rtp_mirror) {
    if (raop_rtp_mirror) {
        raop_rtp_mirror_stop(raop_rtp_mirror);
        MUTEX_DESTROY(raop_rtp_mirror->run_mutex);
        mirror_buffer_destroy(raop_rtp_mirror->buffer);
        free(raop_rtp_mirror);
    }
}

static int
raop_rtp_init_mirror_sockets(raop_rtp_mirror_t *raop_rtp_mirror, int use_ipv6)
{
    int dsock = -1;
    unsigned short dport = 0;

    assert(raop_rtp_mirror);

    dsock = netutils_init_socket(&dport, use_ipv6, 0);
    if (dsock == -1) {
        goto sockets_cleanup;
    }

    /* Listen to the data socket if using TCP */
    if (listen(dsock, 1) < 0) {
        goto sockets_cleanup;
    }

    /* Set socket descriptors */
    raop_rtp_mirror->mirror_data_sock = dsock;

    /* Set port values */
    raop_rtp_mirror->mirror_data_lport = dport;
    return 0;

    sockets_cleanup:
    if (dsock != -1) closesocket(dsock);
    return -1;
}
