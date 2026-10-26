/*
 * log.h - Thread-safe leveled logger with 10 MB file rotation.
 */
#ifndef CAPTURE_APP_LOG_H
#define CAPTURE_APP_LOG_H

#include <stddef.h>

typedef enum {
    LOG_LEVEL_DEBUG = 0,
    LOG_LEVEL_INFO  = 1,
    LOG_LEVEL_WARN  = 2,
    LOG_LEVEL_ERROR = 3
} log_level_t;

int  log_init(log_level_t level, const char *file_path);
void log_shutdown(void);
int  log_reopen(void);
void log_set_level(log_level_t level);
log_level_t log_get_level(void);
int  log_parse_level(const char *str, log_level_t *out_level);
const char *log_level_to_string(log_level_t level);

void log_write(log_level_t level, const char *component, const char *fmt, ...)
    __attribute__((format(printf, 3, 4)));

#define LOG_DEBUG(comp, ...) log_write(LOG_LEVEL_DEBUG, (comp), __VA_ARGS__)
#define LOG_INFO(comp, ...)  log_write(LOG_LEVEL_INFO,  (comp), __VA_ARGS__)
#define LOG_WARN(comp, ...)  log_write(LOG_LEVEL_WARN,  (comp), __VA_ARGS__)
#define LOG_ERROR(comp, ...) log_write(LOG_LEVEL_ERROR, (comp), __VA_ARGS__)

#endif /* CAPTURE_APP_LOG_H */
