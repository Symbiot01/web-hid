/*
 * pipeline.c - Bounded queue with drop policies (oldest / newest / block),
 *              DMA-BUF fd duplication for safe encoder hold, and atomic counters.
 */
#define _POSIX_C_SOURCE 200809L

#include "pipeline.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct pipeline_queue {
    capture_frame_t *slots;
    uint32_t         capacity;
    uint32_t         head;
    uint32_t         tail;
    uint32_t         count;
    drop_policy_t    policy;
    bool             stopped;

    pthread_mutex_t  mtx;
    pthread_cond_t   not_empty;
    pthread_cond_t   not_full;

    atomic_uint_fast64_t captured;
    atomic_uint_fast64_t encoded;
    atomic_uint_fast64_t published;
    atomic_uint_fast64_t dropped;
    atomic_uint_fast64_t reconnect_count;
};

void capture_frame_release(capture_frame_t *frame)
{
    if (!frame) {
        return;
    }
    if (frame->dma_fd >= 0) {
        close(frame->dma_fd);
        frame->dma_fd = -1;
    }
    if (frame->mem_ptr) {
        free(frame->mem_ptr);
        frame->mem_ptr = NULL;
        frame->mem_size = 0;
    }
}

static int clone_frame_resources(capture_frame_t *dst, const capture_frame_t *src)
{
    *dst = *src;
    dst->dma_fd  = -1;
    dst->mem_ptr = NULL;

    if (src->dma_fd >= 0) {
        int dup_fd = fcntl(src->dma_fd, F_DUPFD_CLOEXEC, 0);
        if (dup_fd < 0) {
            return -1;
        }
        dst->dma_fd = dup_fd;
    }
    if (src->mem_ptr && src->mem_size > 0) {
        dst->mem_ptr = malloc(src->mem_size);
        if (!dst->mem_ptr) {
            if (dst->dma_fd >= 0) {
                close(dst->dma_fd);
                dst->dma_fd = -1;
            }
            return -1;
        }
        memcpy(dst->mem_ptr, src->mem_ptr, src->mem_size);
    }
    return 0;
}

pipeline_queue_t *pipeline_create(uint32_t capacity, drop_policy_t policy)
{
    if (capacity == 0 || capacity > 1024) {
        return NULL;
    }
    pipeline_queue_t *q = calloc(1, sizeof(*q));
    if (!q) {
        return NULL;
    }
    q->slots = calloc(capacity, sizeof(capture_frame_t));
    if (!q->slots) {
        free(q);
        return NULL;
    }
    for (uint32_t i = 0; i < capacity; ++i) {
        q->slots[i].dma_fd = -1;
    }
    q->capacity = capacity;
    q->policy   = policy;

    pthread_mutex_init(&q->mtx, NULL);
    pthread_condattr_t cattr;
    pthread_condattr_init(&cattr);
    pthread_condattr_setclock(&cattr, CLOCK_MONOTONIC);
    pthread_cond_init(&q->not_empty, &cattr);
    pthread_cond_init(&q->not_full, &cattr);
    pthread_condattr_destroy(&cattr);

    atomic_init(&q->captured, 0);
    atomic_init(&q->encoded, 0);
    atomic_init(&q->published, 0);
    atomic_init(&q->dropped, 0);
    atomic_init(&q->reconnect_count, 0);
    return q;
}

void pipeline_stop(pipeline_queue_t *q)
{
    if (!q) {
        return;
    }
    pthread_mutex_lock(&q->mtx);
    q->stopped = true;
    pthread_cond_broadcast(&q->not_empty);
    pthread_cond_broadcast(&q->not_full);
    pthread_mutex_unlock(&q->mtx);
}

void pipeline_destroy(pipeline_queue_t *q)
{
    if (!q) {
        return;
    }
    pthread_mutex_lock(&q->mtx);
    for (uint32_t i = 0; i < q->count; ++i) {
        uint32_t idx = (q->head + i) % q->capacity;
        capture_frame_release(&q->slots[idx]);
    }
    q->count = 0;
    pthread_mutex_unlock(&q->mtx);

    pthread_cond_destroy(&q->not_empty);
    pthread_cond_destroy(&q->not_full);
    pthread_mutex_destroy(&q->mtx);
    free(q->slots);
    free(q);
}

int pipeline_push(pipeline_queue_t *q, const capture_frame_t *in_frame)
{
    if (!q || !in_frame) {
        return -1;
    }

    pthread_mutex_lock(&q->mtx);
    if (q->stopped) {
        pthread_mutex_unlock(&q->mtx);
        return -1;
    }

    atomic_fetch_add_explicit(&q->captured, 1, memory_order_relaxed);

    if (q->count == q->capacity) {
        if (q->policy == DROP_POLICY_NEWEST) {
            atomic_fetch_add_explicit(&q->dropped, 1, memory_order_relaxed);
            pthread_mutex_unlock(&q->mtx);
            return 1; /* dropped newest */
        } else if (q->policy == DROP_POLICY_OLDEST) {
            capture_frame_release(&q->slots[q->head]);
            q->head = (q->head + 1) % q->capacity;
            q->count--;
            atomic_fetch_add_explicit(&q->dropped, 1, memory_order_relaxed);
        } else {
            /* DROP_POLICY_BLOCK */
            while (q->count == q->capacity && !q->stopped) {
                pthread_cond_wait(&q->not_full, &q->mtx);
            }
            if (q->stopped) {
                pthread_mutex_unlock(&q->mtx);
                return -1;
            }
        }
    }

    capture_frame_t cloned;
    if (clone_frame_resources(&cloned, in_frame) != 0) {
        atomic_fetch_add_explicit(&q->dropped, 1, memory_order_relaxed);
        pthread_mutex_unlock(&q->mtx);
        return -1;
    }

    q->slots[q->tail] = cloned;
    q->tail = (q->tail + 1) % q->capacity;
    q->count++;

    pthread_cond_signal(&q->not_empty);
    pthread_mutex_unlock(&q->mtx);
    return 0;
}

int pipeline_pop(pipeline_queue_t *q, capture_frame_t *out_frame, int timeout_ms)
{
    if (!q || !out_frame) {
        return -1;
    }

    pthread_mutex_lock(&q->mtx);
    if (q->count == 0 && !q->stopped && timeout_ms != 0) {
        if (timeout_ms < 0) {
            while (q->count == 0 && !q->stopped) {
                pthread_cond_wait(&q->not_empty, &q->mtx);
            }
        } else {
            struct timespec ts;
            clock_gettime(CLOCK_MONOTONIC, &ts);
            ts.tv_sec  += timeout_ms / 1000;
            ts.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
            if (ts.tv_nsec >= 1000000000L) {
                ts.tv_sec += 1;
                ts.tv_nsec -= 1000000000L;
            }
            while (q->count == 0 && !q->stopped) {
                int rc = pthread_cond_timedwait(&q->not_empty, &q->mtx, &ts);
                if (rc == ETIMEDOUT) {
                    break;
                }
            }
        }
    }

    if (q->count == 0) {
        pthread_mutex_unlock(&q->mtx);
        return -1;
    }

    *out_frame = q->slots[q->head];
    memset(&q->slots[q->head], 0, sizeof(capture_frame_t));
    q->slots[q->head].dma_fd = -1;
    q->head = (q->head + 1) % q->capacity;
    q->count--;

    pthread_cond_signal(&q->not_full);
    pthread_mutex_unlock(&q->mtx);
    return 0;
}

void pipeline_inc_encoded(pipeline_queue_t *q)
{
    if (q) {
        atomic_fetch_add_explicit(&q->encoded, 1, memory_order_relaxed);
    }
}

void pipeline_inc_published(pipeline_queue_t *q)
{
    if (q) {
        atomic_fetch_add_explicit(&q->published, 1, memory_order_relaxed);
    }
}

void pipeline_inc_reconnect(pipeline_queue_t *q)
{
    if (q) {
        atomic_fetch_add_explicit(&q->reconnect_count, 1, memory_order_relaxed);
    }
}

void pipeline_get_stats(pipeline_queue_t *q, pipeline_stats_t *out_stats)
{
    if (!q || !out_stats) {
        return;
    }
    out_stats->captured        = atomic_load_explicit(&q->captured, memory_order_relaxed);
    out_stats->encoded         = atomic_load_explicit(&q->encoded, memory_order_relaxed);
    out_stats->published       = atomic_load_explicit(&q->published, memory_order_relaxed);
    out_stats->dropped         = atomic_load_explicit(&q->dropped, memory_order_relaxed);
    out_stats->reconnect_count = atomic_load_explicit(&q->reconnect_count, memory_order_relaxed);
}

void pipeline_log_stats(pipeline_queue_t *q)
{
    pipeline_stats_t st;
    pipeline_get_stats(q, &st);
    LOG_INFO("pipeline",
             "stats captured=%" PRIu64 " encoded=%" PRIu64 " published=%" PRIu64
             " dropped=%" PRIu64 " reconnects=%" PRIu64,
             st.captured, st.encoded, st.published, st.dropped, st.reconnect_count);
}
