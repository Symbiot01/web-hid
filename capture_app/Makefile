# capture-app Makefile
# Strict C11 build with libportal, libpipewire-0.3, glib-2.0, libva, libva-drm,
# libdatachannel, openssl, and libcurl.

CC          ?= gcc
PREFIX      ?= /usr/local
BINDIR      ?= $(PREFIX)/bin
SYSCONFDIR  ?= /etc/capture-app

VERSION_STR := $(shell tr -d '\r\n' < VERSION)
GIT_HASH    := $(shell git rev-parse --short HEAD 2>/dev/null || echo "local")

# Include local sysroot pkg-config path if host dev packages were extracted locally
LOCAL_PC    := $(CURDIR)/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig
PKG_ENV     := PKG_CONFIG_PATH="$(LOCAL_PC):$$PKG_CONFIG_PATH"

PKGS        := libportal libpipewire-0.3 glib-2.0 gio-2.0 libva libva-drm libdatachannel openssl libcurl
PKG_CFLAGS  := $(shell $(PKG_ENV) pkg-config --cflags $(PKGS))
PKG_LIBS    := $(shell $(PKG_ENV) pkg-config --libs $(PKGS)) -lpthread

# Suppress pedantic macro warnings inside system SPA/PipeWire headers by marking them -isystem
PKG_CFLAGS_SYS := $(patsubst -I%,-isystem %,$(PKG_CFLAGS))

CFLAGS      := -std=c11 -Wall -Wextra -Wpedantic -Werror \
               -fstack-protector-strong -D_FORTIFY_SOURCE=2 -O2 \
               -DVERSION=\"$(VERSION_STR)\" -DBUILD_HASH=\"$(GIT_HASH)\" \
               $(PKG_CFLAGS_SYS)

LDFLAGS     := $(PKG_LIBS)

TARGET      := capture-app

COMMON_SRCS := src/log.c \
               src/config.c \
               src/pipeline.c \
               src/http.c \
               src/portal.c \
               src/pw_capture.c \
               src/vaapi_encoder.c \
               src/whip_publisher.c

MAIN_SRCS   := $(COMMON_SRCS) src/main.c
MAIN_OBJS   := $(MAIN_SRCS:.c=.o)

TEST_CONFIG_BIN := tests/test_config
TEST_QUEUE_BIN  := tests/test_queue

.PHONY: all clean install uninstall check

all: $(TARGET)

$(TARGET): $(MAIN_OBJS)
	$(CC) $(CFLAGS) -o $@ $(MAIN_OBJS) $(LDFLAGS)

src/%.o: src/%.c
	$(CC) $(CFLAGS) -c -o $@ $<

$(TEST_CONFIG_BIN): tests/test_config.c src/config.o src/log.o
	$(CC) $(CFLAGS) -o $@ tests/test_config.c src/config.o src/log.o $(LDFLAGS)

$(TEST_QUEUE_BIN): tests/test_queue.c src/pipeline.o src/config.o src/log.o
	$(CC) $(CFLAGS) -o $@ tests/test_queue.c src/pipeline.o src/config.o src/log.o $(LDFLAGS)

check: $(TARGET) $(TEST_CONFIG_BIN) $(TEST_QUEUE_BIN)
	@echo "--- Running unit tests ---"
	./$(TEST_CONFIG_BIN)
	./$(TEST_QUEUE_BIN)
	@echo "--- Running integration & failure tests ---"
	chmod +x tests/test_pipeline_integration.sh
	./tests/test_pipeline_integration.sh

install: $(TARGET)
	install -d $(DESTDIR)$(BINDIR)
	install -m 0755 $(TARGET) $(DESTDIR)$(BINDIR)/$(TARGET)
	install -d $(DESTDIR)$(SYSCONFDIR)
	@if [ ! -f $(DESTDIR)$(SYSCONFDIR)/config.ini ]; then \
		install -m 0644 config/config.ini.example $(DESTDIR)$(SYSCONFDIR)/config.ini; \
	fi

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/$(TARGET)

clean:
	rm -f $(TARGET) src/*.o $(TEST_CONFIG_BIN) $(TEST_QUEUE_BIN)
