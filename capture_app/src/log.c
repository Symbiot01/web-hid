/*
 * log.c - Thread-safe leveled logger with millisecond timestamps & 10 MB rotation.
 */
#define _POSIX_C_SOURCE 200809L

#include "log.h"

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define LOG_ROTATE_BYTES (10ULL * 1024ULL * 1024ULL)
#define LOG_MAX_BACKUPS  3

static pthread_mutex_t g_log_mutex = PTHREAD_MUTEX_INITIALIZER;
static log_level_t     g_log_level = LOG_LEVEL_INFO;
static FILE           *g_log_fp    = NULL;
static char            g_log_path[512];

static void rotate_locked(void)
{
    if (g_log_path[0] == '\0' || g_log_fp == NULL || g_log_fp == stderr) {
        return;
    }

    fflush(g_log_fp);
    struct stat st;
    if (stat(g_log_path, &st) != 0) {
        return;
    }
    if ((unsigned long long)st.st_size < LOG_ROTATE_BYTES) {
        return;
    }

    fclose(g_log_fp);
    g_log_fp = NULL;

    char old_name[600];
    char new_name[600];

    /* Keep at most 3 backups: .1, .2, .3 */
    snprintf(old_name, sizeof(old_name), "%s.%d", g_log_path, LOG_MAX_BACKUPS);
    (void)unlink(old_name);

    for (int i = LOG_MAX_BACKUPS - 1; i >= 1; --i) {
        snprintf(old_name, sizeof(old_name), "%s.%d", g_log_path, i);
        snprintf(new_name, sizeof(new_name), "%s.%d", g_log_path, i + 1);
        (void)rename(old_name, new_name);
    }

    snprintf(new_name, sizeof(new_name), "%s.1", g_log_path);
    (void)rename(g_log_path, new_name);

    g_log_fp = fopen(g_log_path, "a");
    if (!g_log_fp) {
        g_log_fp = stderr;
    }
}

int log_init(log_level_t level, const char *file_path)
{
    pthread_mutex_lock(&g_log_mutex);
    g_log_level = level;

    if (g_log_fp && g_log_fp != stderr) {
        fclose(g_log_fp);
        g_log_fp = NULL;
    }
    g_log_path[0] = '\0';

    if (file_path && file_path[0] != '\0' && strcmp(file_path, "stderr") != 0) {
        snprintf(g_log_path, sizeof(g_log_path), "%s", file_path);
        g_log_fp = fopen(g_log_path, "a");
        if (!g_log_fp) {
            g_log_fp = stderr;
            pthread_mutex_unlock(&g_log_mutex);
            return -1;
        }
    } else {
        g_log_fp = stderr;
    }

    pthread_mutex_unlock(&g_log_mutex);
    return 0;
}

void log_shutdown(void)
{
    pthread_mutex_lock(&g_log_mutex);
    if (g_log_fp && g_log_fp != stderr) {
        fflush(g_log_fp);
        fclose(g_log_fp);
    }
    g_log_fp = stderr;
    g_log_path[0] = '\0';
    pthread_mutex_unlock(&g_log_mutex);
}

int log_reopen(void)
{
    pthread_mutex_lock(&g_log_mutex);
    if (g_log_path[0] == '\0') {
        pthread_mutex_unlock(&g_log_mutex);
        return 0;
    }
    if (g_log_fp && g_log_fp != stderr) {
        fflush(g_log_fp);
        fclose(g_log_fp);
    }
    g_log_fp = fopen(g_log_path, "a");
    if (!g_log_fp) {
        g_log_fp = stderr;
        pthread_mutex_unlock(&g_log_mutex);
        return -1;
    }
    pthread_mutex_unlock(&g_log_mutex);
    return 0;
}

void log_set_level(log_level_t level)
{
    pthread_mutex_lock(&g_log_mutex);
    g_log_level = level;
    pthread_mutex_unlock(&g_log_mutex);
}

log_level_t log_get_level(void)
{
    pthread_mutex_lock(&g_log_mutex);
    log_level_t lvl = g_log_level;
    pthread_mutex_unlock(&g_log_mutex);
    return lvl;
}

int log_parse_level(const char *str, log_level_t *out_level)
{
    if (!str || !out_level) {
        return -1;
    }
    if (strcasecmp(str, "DEBUG") == 0) {
        *out_level = LOG_LEVEL_DEBUG;
        return 0;
    }
    if (strcasecmp(str, "INFO") == 0) {
        *out_level = LOG_LEVEL_INFO;
        return 0;
    }
    if (strcasecmp(str, "WARN") == 0 || strcasecmp(str, "WARNING") == 0) {
        *out_level = LOG_LEVEL_WARN;
        return 0;
    }
    if (strcasecmp(str, "ERROR") == 0 || strcasecmp(str, "ERR") == 0) {
        *out_level = LOG_LEVEL_ERROR;
        return 0;
    }
    return -1;
}

const char *log_level_to_string(log_level_t level)
{
    switch (level) {
    case LOG_LEVEL_DEBUG: return "DEBUG";
    case LOG_LEVEL_INFO:  return "INFO ";
    case LOG_LEVEL_WARN:  return "WARN ";
    case LOG_LEVEL_ERROR: return "ERROR";
    default:              return "INFO ";
    }
}

void log_write(log_level_t level, const char *component, const char *fmt, ...)
{
    pthread_mutex_lock(&g_log_mutex);
    if (level < g_log_level) {
        pthread_mutex_unlock(&g_log_mutex);
        return;
    }

    if (!g_log_fp) {
        g_log_fp = stderr;
    }

    rotate_locked();

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm_val;
    localtime_r(&ts.tv_sec, &tm_val);

    long ms = ts.tv_nsec / 1000000L;
    fprintf(g_log_fp, "[%04d-%02d-%02d %02d:%02d:%02d.%03ld] [%s] %s: ",
            tm_val.tm_year + 1900,
            tm_val.tm_mon + 1,
            tm_val.tm_mday,
            tm_val.tm_hour,
            tm_val.tm_min,
            tm_val.tm_sec,
            ms,
            log_level_to_string(level),
            component ? component : "app");

    va_list ap;
    va_start(ap, fmt);
    vfprintf(g_log_fp, fmt, ap);
    va_end(ap);

    fputc('\n', g_log_fp);
    fflush(g_log_fp);
    pthread_mutex_unlock(&g_log_mutex);
}
