/*
 * test_queue.c - Unit tests for bounded pipeline queue, drop policies, and FD lifecycle.
 */
#define _POSIX_C_SOURCE 200809L

#include "../src/pipeline.h"

#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void test_drop_oldest_policy(void)
{
    pipeline_queue_t *q = pipeline_create(2, DROP_POLICY_OLDEST);
    assert(q != NULL);

    for (uint64_t i = 1; i <= 4; ++i) {
        capture_frame_t f;
        memset(&f, 0, sizeof(f));
        f.sequence = i;
        f.width    = 640;
        f.height   = 360;
        f.dma_fd   = -1;
        assert(pipeline_push(q, &f) == 0);
    }

    pipeline_stats_t st;
    pipeline_get_stats(q, &st);
    assert(st.captured == 4);
    assert(st.dropped == 2);

    /* Remaining frames in queue of depth 2 must be sequences 3 and 4 */
    capture_frame_t out;
    assert(pipeline_pop(q, &out, 0) == 0);
    assert(out.sequence == 3);
    capture_frame_release(&out);

    assert(pipeline_pop(q, &out, 0) == 0);
    assert(out.sequence == 4);
    capture_frame_release(&out);

    assert(pipeline_pop(q, &out, 0) != 0);
    pipeline_destroy(q);
    printf("[PASS] test_drop_oldest_policy\n");
}

static void test_drop_newest_policy(void)
{
    pipeline_queue_t *q = pipeline_create(2, DROP_POLICY_NEWEST);
    assert(q != NULL);

    for (uint64_t i = 1; i <= 4; ++i) {
        capture_frame_t f;
        memset(&f, 0, sizeof(f));
        f.sequence = i;
        f.dma_fd   = -1;
        int rc = pipeline_push(q, &f);
        if (i <= 2) {
            assert(rc == 0);
        } else {
            assert(rc == 1); /* newest dropped */
        }
    }

    pipeline_stats_t st;
    pipeline_get_stats(q, &st);
    assert(st.captured == 4);
    assert(st.dropped == 2);

    /* Remaining frames must be sequences 1 and 2 */
    capture_frame_t out;
    assert(pipeline_pop(q, &out, 0) == 0);
    assert(out.sequence == 1);
    capture_frame_release(&out);

    assert(pipeline_pop(q, &out, 0) == 0);
    assert(out.sequence == 2);
    capture_frame_release(&out);

    pipeline_destroy(q);
    printf("[PASS] test_drop_newest_policy\n");
}

static void *consumer_worker(void *arg)
{
    pipeline_queue_t *q = (pipeline_queue_t *)arg;
    struct timespec req = { .tv_sec = 0, .tv_nsec = 25000000L }; /* 25 ms */
    nanosleep(&req, NULL);

    for (int i = 0; i < 4; ++i) {
        capture_frame_t out;
        if (pipeline_pop(q, &out, 1000) == 0) {
            pipeline_inc_encoded(q);
            pipeline_inc_published(q);
            capture_frame_release(&out);
        }
    }
    return NULL;
}

static void test_block_policy_and_dmabuf_dup(void)
{
    pipeline_queue_t *q = pipeline_create(2, DROP_POLICY_BLOCK);
    assert(q != NULL);

    int pipe_fds[2];
    assert(pipe(pipe_fds) == 0);

    pthread_t tid;
    assert(pthread_create(&tid, NULL, consumer_worker, q) == 0);

    for (uint64_t i = 1; i <= 4; ++i) {
        capture_frame_t f;
        memset(&f, 0, sizeof(f));
        f.sequence = i;
        f.dma_fd   = pipe_fds[0]; /* pipeline_push duplicates this fd */
        f.dma_size = 4096;
        assert(pipeline_push(q, &f) == 0);
    }

    pthread_join(tid, NULL);

    pipeline_stats_t st;
    pipeline_get_stats(q, &st);
    assert(st.captured == 4);
    assert(st.dropped == 0);
    assert(st.encoded == 4);
    assert(st.published == 4);

    close(pipe_fds[0]);
    close(pipe_fds[1]);
    pipeline_destroy(q);
    printf("[PASS] test_block_policy_and_dmabuf_dup\n");
}

int main(void)
{
    test_drop_oldest_policy();
    test_drop_newest_policy();
    test_block_policy_and_dmabuf_dup();
    printf("All queue unit tests passed.\n");
    return 0;
}
