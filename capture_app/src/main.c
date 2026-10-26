/*
 * main.c - Entry point, signal lifecycle, and pipeline orchestration for capture-app.
 *
 * Exit codes:
 *   0   success
 *   1   general error (or bad CLI / bad mTLS cert)
 *   2   user denied portal consent
 *   3   cannot reach WHIP endpoint after retries
 *   4   encoder initialization failure (VAAPI unavailable)
 *   5   capture failure (PipeWire disconnect that couldn't recover)
 *   130 forced immediate exit on second SIGINT
 */
#define _POSIX_C_SOURCE 200809L

#include "config.h"
#include "http.h"
#include "log.h"
#include "pipeline.h"
#include "portal.h"
#include "pw_capture.h"
#include "vaapi_encoder.h"
#include "whip_publisher.h"

#include <curl/curl.h>
#include <ctype.h>
#include <dirent.h>
#include <drm/drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef VERSION
#define VERSION "1.0.0"
#endif

#ifndef BUILD_HASH
#define BUILD_HASH "dev"
#endif

#define EXIT_OK              0
#define EXIT_GENERAL_ERR     1
#define EXIT_PORTAL_DENIED   2
#define EXIT_WHIP_UNREACH    3
#define EXIT_VAAPI_FAIL      4
#define EXIT_CAPTURE_FAIL    5
#define EXIT_FORCED_SIGINT   130

static volatile sig_atomic_t g_stop_requested   = 0;
static volatile sig_atomic_t g_dump_stats_req   = 0;
static volatile sig_atomic_t g_reopen_log_req   = 0;
static volatile sig_atomic_t g_sigint_count     = 0;

static void signal_handler(int sig)
{
    if (sig == SIGINT) {
        g_sigint_count++;
        if (g_sigint_count >= 2) {
            const char msg[] = "\ncapture-app: second SIGINT received, forcing immediate exit (130)\n";
            (void)!write(STDERR_FILENO, msg, sizeof(msg) - 1);
            _exit(EXIT_FORCED_SIGINT);
        }
        g_stop_requested = 1;
    } else if (sig == SIGTERM) {
        g_stop_requested = 1;
    } else if (sig == SIGUSR1) {
        g_dump_stats_req = 1;
    } else if (sig == SIGHUP) {
        g_reopen_log_req = 1;
    }
}

static void install_signal_handlers(void)
{
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGUSR1, &sa, NULL);
    sigaction(SIGHUP,  &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
}

static void ensure_parent_dir(const char *filepath)
{
    if (!filepath || filepath[0] == '\0' || strcmp(filepath, "stderr") == 0) {
        return;
    }
    char buf[512];
    snprintf(buf, sizeof(buf), "%s", filepath);
    for (char *p = buf + 1; *p; ++p) {
        if (*p == '/') {
            *p = '\0';
            (void)mkdir(buf, 0700);
            *p = '/';
        }
    }
}

static bool is_capture_app_pid(pid_t pid)
{
    if (pid <= 1 || pid == getpid()) {
        return false;
    }
    if (kill(pid, 0) != 0) {
        return false;
    }
    char comm_path[128];
    snprintf(comm_path, sizeof(comm_path), "/proc/%d/comm", (int)pid);
    FILE *fp = fopen(comm_path, "r");
    if (!fp) {
        return false;
    }
    char comm[64] = {0};
    bool match = false;
    if (fgets(comm, sizeof(comm), fp) != NULL) {
        size_t len = strlen(comm);
        while (len > 0 && (comm[len - 1] == '\n' || comm[len - 1] == '\r')) {
            comm[--len] = '\0';
        }
        if (strcmp(comm, "capture-app") == 0) {
            match = true;
        }
    }
    fclose(fp);
    return match;
}

static pid_t find_running_pid(const char *pid_file)
{
    if (pid_file && pid_file[0] != '\0') {
        FILE *fp = fopen(pid_file, "r");
        if (fp) {
            int p = 0;
            if (fscanf(fp, "%d", &p) == 1 && is_capture_app_pid((pid_t)p)) {
                fclose(fp);
                return (pid_t)p;
            }
            fclose(fp);
        }
    }

    /* Fallback: scan /proc for capture-app owned by current user */
    DIR *dir = opendir("/proc");
    if (!dir) {
        return -1;
    }
    uid_t my_uid = getuid();
    struct dirent *ent;
    pid_t found = -1;
    while ((ent = readdir(dir)) != NULL) {
        if (!isdigit((unsigned char)ent->d_name[0])) {
            continue;
        }
        pid_t p = (pid_t)atoi(ent->d_name);
        if (!is_capture_app_pid(p)) {
            continue;
        }
        char proc_dir[128];
        snprintf(proc_dir, sizeof(proc_dir), "/proc/%d", (int)p);
        struct stat st;
        if (stat(proc_dir, &st) == 0 && st.st_uid == my_uid) {
            found = p;
            break;
        }
    }
    closedir(dir);
    return found;
}

static int handle_stop_command(const app_config_t *cfg, bool quiet_if_not_running)
{
    pid_t pid = find_running_pid(cfg->pid_file);
    if (pid <= 0) {
        if (!quiet_if_not_running) {
            printf("capture-app is not running.\n");
        }
        return 0;
    }

    printf("Stopping capture-app (PID %d)...\n", (int)pid);
    if (kill(pid, SIGTERM) != 0) {
        fprintf(stderr, "capture-app: failed to send SIGTERM to PID %d: %s\n",
                (int)pid, strerror(errno));
        return EXIT_GENERAL_ERR;
    }

    /* Wait up to 6 seconds for graceful WHIP DELETE + portal close */
    for (int i = 0; i < 120; ++i) {
        if (kill(pid, 0) != 0) {
            if (cfg->pid_file[0] != '\0') {
                (void)unlink(cfg->pid_file);
            }
            printf("[OK] capture-app (PID %d) stopped cleanly.\n", (int)pid);
            return EXIT_OK;
        }
        struct timespec ts = { .tv_sec = 0, .tv_nsec = 50 * 1000 * 1000L };
        nanosleep(&ts, NULL);
    }

    fprintf(stderr, "capture-app: PID %d did not exit in time; sending SIGKILL\n", (int)pid);
    (void)kill(pid, SIGKILL);
    if (cfg->pid_file[0] != '\0') {
        (void)unlink(cfg->pid_file);
    }
    return EXIT_OK;
}

static int handle_status_command(const app_config_t *cfg)
{
    pid_t pid = find_running_pid(cfg->pid_file);
    if (pid <= 0) {
        printf("Status: stopped (no running capture-app process)\n");
        return EXIT_GENERAL_ERR;
    }

    printf("Status  : running (PID %d)\n", (int)pid);
    printf("Log file: %s\n", cfg->log_file);

    /* Send SIGUSR1 so capture-app writes fresh pipeline stats to its log */
    (void)kill(pid, SIGUSR1);
    struct timespec ts = { .tv_sec = 0, .tv_nsec = 120 * 1000 * 1000L };
    nanosleep(&ts, NULL);

    if (strcmp(cfg->log_file, "stderr") != 0 && access(cfg->log_file, R_OK) == 0) {
        FILE *fp = fopen(cfg->log_file, "r");
        if (fp) {
            char ring[8][512];
            int count = 0;
            char line[512];
            while (fgets(line, sizeof(line), fp) != NULL) {
                snprintf(ring[count % 8], sizeof(ring[0]), "%s", line);
                count++;
            }
            fclose(fp);
            int start = (count > 8) ? (count - 8) : 0;
            printf("\nRecent log output:\n");
            for (int i = start; i < count; ++i) {
                printf("  %s", ring[i % 8]);
            }
        }
    }
    return EXIT_OK;
}

static void notify_daemon_parent(int *pipe_wr_fd, int status_code)
{
    if (!pipe_wr_fd || *pipe_wr_fd < 0) {
        return;
    }
    int msg[2] = { status_code, (int)getpid() };
    (void)!write(*pipe_wr_fd, msg, sizeof(msg));
    close(*pipe_wr_fd);
    *pipe_wr_fd = -1;
}

static void detach_stdio_to_devnull(void)
{
    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd >= 0) {
        (void)dup2(null_fd, STDIN_FILENO);
        (void)dup2(null_fd, STDOUT_FILENO);
        (void)dup2(null_fd, STDERR_FILENO);
        if (null_fd > STDERR_FILENO) {
            close(null_fd);
        }
    }
}

static int write_pid_file(const char *path)
{
    if (!path || path[0] == '\0') {
        return 0;
    }
    ensure_parent_dir(path);
    FILE *fp = fopen(path, "w");
    if (!fp) {
        LOG_ERROR("main", "failed to write pid file '%s': %s", path, strerror(errno));
        return -1;
    }
    fprintf(fp, "%d\n", (int)getpid());
    fclose(fp);
    return 0;
}

static void remove_pid_file(const char *path)
{
    if (path && path[0] != '\0') {
        (void)unlink(path);
    }
}

static uint64_t monotonic_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

typedef struct {
    const app_config_t *cfg;
    atomic_bool        *video_wanted;
    atomic_bool        *streaming_now;
} console_poll_ctx_t;

static void *console_poll_thread(void *arg)
{
    console_poll_ctx_t *cctx = (console_poll_ctx_t *)arg;
    bool last_reported_streaming = false;
    uint64_t last_status_ns = 0;

    while (!g_stop_requested) {
        bool cur_streaming = atomic_load_explicit(cctx->streaming_now, memory_order_relaxed);
        uint64_t now = monotonic_ns();
        if (cur_streaming != last_reported_streaming ||
            last_status_ns == 0 ||
            (now - last_status_ns) >= 10000000000ULL) {
            if (http_console_post_status(cctx->cfg, cur_streaming,
                                         cctx->cfg->fps, cctx->cfg->bitrate_kbps) == 0) {
                last_reported_streaming = cur_streaming;
                last_status_ns = now;
            }
        }

        bool wanted = atomic_load_explicit(cctx->video_wanted, memory_order_relaxed);
        bool snap = false;
        int rc = http_console_poll(cctx->cfg, 8, &wanted, &snap);
        if (rc == 0) {
            bool prev = atomic_exchange_explicit(cctx->video_wanted, wanted, memory_order_relaxed);
            if (prev != wanted) {
                LOG_INFO("main", "console demand signal changed: video_wanted=%s",
                         wanted ? "true (active)" : "false (standby — saving Wi-Fi bandwidth)");
            }
        } else if (!g_stop_requested) {
            bool prev = atomic_exchange_explicit(cctx->video_wanted, true, memory_order_relaxed);
            if (!prev) {
                LOG_WARN("main", "console poll failed; falling back to active streaming");
            }
            struct timespec req = { .tv_sec = 2, .tv_nsec = 0 };
            nanosleep(&req, NULL);
        }
    }
    return NULL;
}

/* Optional synthetic producer thread used by headless `make check` integration test */
typedef struct {
    const app_config_t *cfg;
    pipeline_queue_t   *queue;
} synth_ctx_t;

static void *synthetic_producer_thread(void *arg)
{
    synth_ctx_t *sctx = (synth_ctx_t *)arg;
    uint32_t w = 640;
    uint32_t h = 360;
    uint32_t stride = w;
    size_t nv12_sz = (size_t)w * h * 3 / 2;
    uint8_t *buf = calloc(1, nv12_sz);
    if (!buf) {
        return NULL;
    }

    uint64_t interval_ns = 1000000000ULL / (sctx->cfg->fps > 0 ? sctx->cfg->fps : 10);
    uint64_t next_ns = monotonic_ns();
    uint64_t seq = 0;

    while (!g_stop_requested) {
        uint64_t now = monotonic_ns();
        if (now < next_ns) {
            uint64_t diff = next_ns - now;
            struct timespec req = {
                .tv_sec  = (time_t)(diff / 1000000000ULL),
                .tv_nsec = (long)(diff % 1000000000ULL)
            };
            nanosleep(&req, NULL);
        }
        next_ns += interval_ns;

        /* Animated gradient pattern in NV12 */
        uint8_t base = (uint8_t)((seq * 4) & 0xff);
        memset(buf, (uint8_t)(16 + (base % 200)), (size_t)w * h);
        memset(buf + (size_t)w * h, 128, (size_t)w * h / 2);

        capture_frame_t frame;
        memset(&frame, 0, sizeof(frame));
        frame.sequence     = ++seq;
        frame.timestamp_ns = monotonic_ns();
        frame.width        = w;
        frame.height       = h;
        frame.stride       = stride;
        frame.drm_format   = DRM_FORMAT_NV12;
        frame.dma_fd       = -1;
        frame.mem_ptr      = buf;
        frame.mem_size     = nv12_sz;

        (void)pipeline_push(sctx->queue, &frame);
    }

    free(buf);
    return NULL;
}

int main(int argc, char **argv)
{
    app_config_t cfg;
    config_init_defaults(&cfg);

    char err_buf[512];
    err_buf[0] = '\0';

    if (config_parse_cli(&cfg, argc, argv, err_buf, sizeof(err_buf)) != 0) {
        fprintf(stderr, "capture-app: configuration error: %s\n", err_buf);
        return EXIT_GENERAL_ERR;
    }

    if (cfg.show_version) {
        printf("capture-app %s (build %s)\n", VERSION, BUILD_HASH);
        return EXIT_OK;
    }
    if (cfg.show_help) {
        config_print_help(argv[0]);
        return EXIT_OK;
    }

    if (cfg.action == ACTION_STOP) {
        return handle_stop_command(&cfg, false);
    }
    if (cfg.action == ACTION_STATUS) {
        return handle_status_command(&cfg);
    }
    if (cfg.action == ACTION_RESTART) {
        (void)handle_stop_command(&cfg, true);
        cfg.action = ACTION_START_DAEMON;
    }

    if (config_validate(&cfg, err_buf, sizeof(err_buf)) != 0) {
        fprintf(stderr, "capture-app: validation error: %s\n", err_buf);
        return EXIT_GENERAL_ERR;
    }

    int daemon_ready_fd = -1;
    if (cfg.action == ACTION_START_DAEMON) {
        pid_t existing = find_running_pid(cfg.pid_file);
        if (existing > 0) {
            printf("capture-app is already running in the background (PID %d).\n"
                   "Use 'capture-app status' or 'capture-app stop' or 'capture-app restart'.\n",
                   (int)existing);
            return EXIT_OK;
        }

        int pipe_fds[2] = { -1, -1 };
        if (pipe(pipe_fds) != 0) {
            fprintf(stderr, "capture-app: pipe() failed: %s\n", strerror(errno));
            return EXIT_GENERAL_ERR;
        }

        printf("Starting capture-app in background (waiting for portal consent & WHIP connection)...\n");
        fflush(stdout);

        pid_t child = fork();
        if (child < 0) {
            fprintf(stderr, "capture-app: fork() failed: %s\n", strerror(errno));
            close(pipe_fds[0]);
            close(pipe_fds[1]);
            return EXIT_GENERAL_ERR;
        }

        if (child > 0) {
            /* Parent CLI process: wait for child to report startup outcome */
            close(pipe_fds[1]);
            int msg[2] = { EXIT_GENERAL_ERR, (int)child };
            ssize_t n = read(pipe_fds[0], msg, sizeof(msg));
            close(pipe_fds[0]);
            if (n == (ssize_t)sizeof(msg) && msg[0] == EXIT_OK) {
                printf("[OK] capture-app is streaming in the background (PID %d)\n"
                       "     WHIP URL : %s\n"
                       "     Log file : %s\n"
                       "     Status   : capture-app status\n"
                       "     Stop     : capture-app stop\n",
                       msg[1], cfg.whip_url, cfg.log_file);
                return EXIT_OK;
            }
            int code = (n == (ssize_t)sizeof(msg)) ? msg[0] : EXIT_GENERAL_ERR;
            fprintf(stderr, "capture-app: background startup failed (exit code %d). Check %s\n",
                    code, cfg.log_file);
            return code;
        }

        /* Child daemon process: detach session and close any inherited caller fds > 2 */
        close(pipe_fds[0]);
        daemon_ready_fd = pipe_fds[1];
        for (int fd_i = 3; fd_i < 256; ++fd_i) {
            if (fd_i != daemon_ready_fd) {
                (void)close(fd_i);
            }
        }
        (void)setsid();
    }

    ensure_parent_dir(cfg.log_file);
    if (log_init(cfg.log_level, cfg.log_file) != 0) {
        fprintf(stderr, "capture-app: failed to open log file '%s'\n", cfg.log_file);
        notify_daemon_parent(&daemon_ready_fd, EXIT_GENERAL_ERR);
        return EXIT_GENERAL_ERR;
    }

    install_signal_handlers();

    if (write_pid_file(cfg.pid_file) != 0) {
        notify_daemon_parent(&daemon_ready_fd, EXIT_GENERAL_ERR);
        log_shutdown();
        return EXIT_GENERAL_ERR;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);

    LOG_INFO("main", "starting capture-app %s (build %s) — fps=%u bitrate=%u kbps gop=%us url=%s",
             VERSION, BUILD_HASH, cfg.fps, cfg.bitrate_kbps,
             cfg.keyframe_interval_sec, cfg.whip_url);

    int exit_code = EXIT_OK;

    pipeline_queue_t *queue = pipeline_create(cfg.pipeline_depth, cfg.drop_policy);
    if (!queue) {
        LOG_ERROR("main", "failed to initialize bounded pipeline queue");
        notify_daemon_parent(&daemon_ready_fd, EXIT_GENERAL_ERR);
        remove_pid_file(cfg.pid_file);
        curl_global_cleanup();
        log_shutdown();
        return EXIT_GENERAL_ERR;
    }

    /* Step 1: Initialize VA-API H.264 encoder first so hardware errors fail fast with code 4 */
    vaapi_encoder_t *encoder = vaapi_encoder_create(&cfg);
    if (!encoder) {
        LOG_ERROR("main", "VA-API encoder initialization failed (exit code 4)");
        notify_daemon_parent(&daemon_ready_fd, EXIT_VAAPI_FAIL);
        pipeline_destroy(queue);
        remove_pid_file(cfg.pid_file);
        curl_global_cleanup();
        log_shutdown();
        return EXIT_VAAPI_FAIL;
    }

    /* Step 2: Acquire portal consent & start PipeWire consumer (or synthetic producer in test mode) */
    portal_ctx_t     *portal = NULL;
    pw_capture_ctx_t *pw_cap = NULL;
    pthread_t         synth_tid;
    bool              synth_running = false;
    synth_ctx_t       synth_ctx = { .cfg = &cfg, .queue = queue };

    if (cfg.synthetic_capture) {
        LOG_INFO("main", "synthetic capture mode enabled");
        if (pthread_create(&synth_tid, NULL, synthetic_producer_thread, &synth_ctx) == 0) {
            synth_running = true;
        }
    } else {
        portal = portal_create(&cfg);
        if (!portal) {
            LOG_ERROR("main", "failed to create XDG portal context");
            notify_daemon_parent(&daemon_ready_fd, EXIT_CAPTURE_FAIL);
            vaapi_encoder_destroy(encoder);
            pipeline_destroy(queue);
            remove_pid_file(cfg.pid_file);
            curl_global_cleanup();
            log_shutdown();
            return EXIT_CAPTURE_FAIL;
        }

        int pw_fd = -1;
        uint32_t pw_node_id = 0;
        portal_status_t pst = portal_start_session(portal, &pw_fd, &pw_node_id);
        if (pst == PORTAL_ERR_USER_DENIED) {
            LOG_ERROR("main", "user denied portal consent (exit code 2)");
            notify_daemon_parent(&daemon_ready_fd, EXIT_PORTAL_DENIED);
            portal_destroy(portal);
            vaapi_encoder_destroy(encoder);
            pipeline_destroy(queue);
            remove_pid_file(cfg.pid_file);
            curl_global_cleanup();
            log_shutdown();
            return EXIT_PORTAL_DENIED;
        } else if (pst != PORTAL_OK) {
            LOG_ERROR("main", "portal screencast initialization failed");
            notify_daemon_parent(&daemon_ready_fd, EXIT_CAPTURE_FAIL);
            portal_destroy(portal);
            vaapi_encoder_destroy(encoder);
            pipeline_destroy(queue);
            remove_pid_file(cfg.pid_file);
            curl_global_cleanup();
            log_shutdown();
            return EXIT_CAPTURE_FAIL;
        }

        pw_cap = pw_capture_create(&cfg, queue);
        if (!pw_cap || pw_capture_start(pw_cap, pw_fd, pw_node_id) != 0) {
            LOG_ERROR("main", "failed to start PipeWire capture stream (exit code 5)");
            notify_daemon_parent(&daemon_ready_fd, EXIT_CAPTURE_FAIL);
            if (pw_cap) pw_capture_destroy(pw_cap);
            portal_destroy(portal);
            vaapi_encoder_destroy(encoder);
            pipeline_destroy(queue);
            remove_pid_file(cfg.pid_file);
            curl_global_cleanup();
            log_shutdown();
            return EXIT_CAPTURE_FAIL;
        }
    }

    /* Step 3: Initialize WHIP publisher & connect (or enter standby if console_url is set) */
    pthread_t console_tid;
    bool console_thread_running = false;
    bool whip_connected = false;
    bool on_demand_mode = (cfg.console_url[0] != '\0' && cfg.capture_token[0] != '\0');
    if (on_demand_mode) {
        if (http_console_post_status(&cfg, false, cfg.fps, cfg.bitrate_kbps) != 0) {
            LOG_WARN("main", "console %s rejected status check (deployment pending or token mismatch); falling back to direct streaming on %s",
                     cfg.console_url, cfg.whip_url);
            on_demand_mode = false;
        }
    }
    atomic_bool video_wanted;
    atomic_bool streaming_now;
    atomic_init(&video_wanted, !on_demand_mode);
    atomic_init(&streaming_now, false);

    console_poll_ctx_t console_ctx = {
        .cfg           = &cfg,
        .video_wanted  = &video_wanted,
        .streaming_now = &streaming_now
    };

    whip_publisher_t *publisher = whip_publisher_create(&cfg, queue, encoder);
    if (!publisher) {
        LOG_ERROR("main", "failed to create WHIP publisher");
        exit_code = EXIT_GENERAL_ERR;
        notify_daemon_parent(&daemon_ready_fd, exit_code);
        goto shutdown_sequence;
    }

    if (on_demand_mode) {
        LOG_INFO("main", "on-demand standby mode enabled (console=%s) — waiting for UI selection before streaming over Wi-Fi",
                 cfg.console_url);
        if (pthread_create(&console_tid, NULL, console_poll_thread, &console_ctx) == 0) {
            console_thread_running = true;
        }
    } else {
        whip_status_t wst = whip_publisher_connect_with_retry(publisher, (volatile int *)&g_stop_requested);
        if (wst == WHIP_ERR_UNREACHABLE) {
            LOG_ERROR("main", "cannot reach WHIP endpoint after configured retries (exit code 3)");
            exit_code = EXIT_WHIP_UNREACH;
            notify_daemon_parent(&daemon_ready_fd, exit_code);
            goto shutdown_sequence;
        } else if (wst == WHIP_ERR_TLS_AUTH) {
            LOG_ERROR("main", "TLS/mTLS error connecting to WHIP endpoint (exit code 1)");
            exit_code = EXIT_GENERAL_ERR;
            notify_daemon_parent(&daemon_ready_fd, exit_code);
            goto shutdown_sequence;
        } else if (wst != WHIP_OK) {
            exit_code = EXIT_OK;
            notify_daemon_parent(&daemon_ready_fd, exit_code);
            goto shutdown_sequence;
        }
        whip_connected = true;
        atomic_store_explicit(&streaming_now, true, memory_order_relaxed);
    }

    if (daemon_ready_fd >= 0) {
        notify_daemon_parent(&daemon_ready_fd, EXIT_OK);
        detach_stdio_to_devnull();
    }

    uint64_t start_ns = monotonic_ns();
    uint64_t duration_ns = (uint64_t)cfg.duration_sec * 1000000000ULL;

    /* Main encode -> publish loop */
    while (!g_stop_requested) {
        if (g_dump_stats_req) {
            g_dump_stats_req = 0;
            pipeline_log_stats(queue);
        }
        if (g_reopen_log_req) {
            g_reopen_log_req = 0;
            (void)log_reopen();
            LOG_INFO("main", "reopened log file on SIGHUP");
        }
        if (duration_ns > 0 && (monotonic_ns() - start_ns) >= duration_ns) {
            LOG_INFO("main", "reached configured duration (%u s), initiating graceful shutdown",
                     cfg.duration_sec);
            break;
        }

        if (!cfg.synthetic_capture) {
            if (portal_is_closed(portal) || pw_capture_has_error(pw_cap)) {
                LOG_WARN("main", "capture stream interrupted; attempting portal/PipeWire recovery...");
                pw_capture_stop(pw_cap);
                int new_fd = -1;
                uint32_t new_node = 0;
                portal_status_t rpst = portal_start_session(portal, &new_fd, &new_node);
                if (rpst == PORTAL_ERR_USER_DENIED) {
                    exit_code = EXIT_PORTAL_DENIED;
                    break;
                }
                if (rpst != PORTAL_OK || pw_capture_start(pw_cap, new_fd, new_node) != 0) {
                    LOG_ERROR("main", "unrecoverable PipeWire capture disconnect (exit code 5)");
                    exit_code = EXIT_CAPTURE_FAIL;
                    break;
                }
            }
        }

        bool want_stream = atomic_load_explicit(&video_wanted, memory_order_relaxed);
        if (!want_stream) {
            if (whip_connected) {
                LOG_INFO("main", "suspending WHIP stream (standby mode — 0 kbps Wi-Fi usage)");
                whip_publisher_disconnect(publisher);
                whip_connected = false;
                atomic_store_explicit(&streaming_now, false, memory_order_relaxed);
                (void)http_console_post_status(&cfg, false, cfg.fps, cfg.bitrate_kbps);
            }
            capture_frame_t idle_frame;
            if (pipeline_pop(queue, &idle_frame, 100) == 0) {
                capture_frame_release(&idle_frame);
            }
            continue;
        }

        if (!whip_connected || whip_publisher_needs_reconnect(publisher)) {
            if (whip_connected) {
                LOG_WARN("main", "WHIP connection lost; reconnecting with backoff...");
            } else {
                LOG_INFO("main", "connecting WHIP stream on UI demand -> %s", cfg.whip_url);
            }
            whip_status_t rwst = whip_publisher_connect_with_retry(
                publisher, (volatile int *)&g_stop_requested);
            if (rwst == WHIP_ERR_UNREACHABLE) {
                exit_code = EXIT_WHIP_UNREACH;
                break;
            } else if (rwst != WHIP_OK) {
                break;
            }
            whip_connected = true;
            atomic_store_explicit(&streaming_now, true, memory_order_relaxed);
            (void)http_console_post_status(&cfg, true, cfg.fps, cfg.bitrate_kbps);
        }

        capture_frame_t frame;
        if (pipeline_pop(queue, &frame, 100) == 0) {
            encoded_au_t au;
            memset(&au, 0, sizeof(au));
            if (vaapi_encoder_encode(encoder, &frame, &au) == 0) {
                pipeline_inc_encoded(queue);
                (void)whip_publisher_send_frame(publisher, &au);
            }
            /* Release DMA-BUF fd / fallback memory ONLY after VAAPI encode is done */
            capture_frame_release(&frame);
        }
    }

shutdown_sequence:
    LOG_INFO("main", "graceful shutdown: stopping capture -> draining pipeline -> flushing encoder -> DELETE WHIP -> closing portal");

    /* 1. Stop new captures */
    g_stop_requested = 1;
    if (console_thread_running) {
        pthread_join(console_tid, NULL);
    }
    if (synth_running) {
        pthread_join(synth_tid, NULL);
    }
    if (pw_cap) {
        pw_capture_stop(pw_cap);
    }
    pipeline_stop(queue);

    /* 2. Drain remaining frames in pipeline and flush through encoder/publisher */
    capture_frame_t drain_frame;
    while (pipeline_pop(queue, &drain_frame, 0) == 0) {
        if (exit_code == EXIT_OK && publisher && whip_connected) {
            encoded_au_t au;
            memset(&au, 0, sizeof(au));
            if (vaapi_encoder_encode(encoder, &drain_frame, &au) == 0) {
                pipeline_inc_encoded(queue);
                (void)whip_publisher_send_frame(publisher, &au);
            }
        }
        capture_frame_release(&drain_frame);
    }

    pipeline_log_stats(queue);

    /* 3. Flush/destroy encoder */
    if (encoder) {
        vaapi_encoder_destroy(encoder);
        encoder = NULL;
    }

    /* 4. DELETE WHIP resource and tear down WebRTC PeerConnection */
    if (publisher) {
        whip_publisher_disconnect(publisher);
        whip_publisher_destroy(publisher);
        publisher = NULL;
    }

    /* 5. Close portal session & destroy PipeWire consumer */
    if (pw_cap) {
        pw_capture_destroy(pw_cap);
        pw_cap = NULL;
    }
    if (portal) {
        portal_close_session(portal);
        portal_destroy(portal);
        portal = NULL;
    }

    /* 6. Final cleanup */
    pipeline_destroy(queue);
    remove_pid_file(cfg.pid_file);
    curl_global_cleanup();
    LOG_INFO("main", "shutdown complete (exit_code=%d)", exit_code);
    log_shutdown();
    return exit_code;
}
