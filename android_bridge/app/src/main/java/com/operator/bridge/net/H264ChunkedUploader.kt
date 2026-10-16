package com.operator.bridge.net

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class H264ChunkedUploader(
    private val base: String,
    private val token: String,
    private val log: (String) -> Unit,
) {
    private val box = ArrayBlockingQueue<ByteArray>(400)
    private val stop = AtomicBoolean(false)
    private val generation = AtomicLong(0)
    private val lock = Any()
    @Volatile private var thread: Thread? = null
    @Volatile private var activeConn: HttpURLConnection? = null
    @Volatile var connected = false
        private set
    @Volatile var error = ""
        private set

    val queued: Int get() = box.size

    fun offer(data: ByteArray) {
        if (stop.get() || data.isEmpty()) return
        if (!box.offer(data)) {
            box.poll()
            box.offer(data)
        }
    }

    fun ensure() {
        synchronized(lock) {
            stop.set(false)
            val current = thread
            if (current != null && current.isAlive) return
            val gen = generation.incrementAndGet()
            thread = Thread({ runLoop(gen) }, "h264-$gen").apply { isDaemon = true; start() }
        }
    }

    fun halt() {
        val conn: HttpURLConnection?
        val worker: Thread?
        synchronized(lock) {
            stop.set(true)
            generation.incrementAndGet()
            connected = false
            box.clear()
            conn = activeConn
            activeConn = null
            worker = thread
            thread = null
        }
        worker?.interrupt()
        if (conn != null) {
            Thread({
                try {
                    conn.disconnect()
                } catch (_: Exception) {
                }
            }, "h264-abort").apply { isDaemon = true; start() }
        }
    }

    /** Force-recycle the current upload connection without stopping video queuing. */
    fun recycle(reason: String) {
        log("h264 upload recycle: $reason")
        val conn: HttpURLConnection?
        synchronized(lock) {
            val nextGen = generation.incrementAndGet()
            connected = false
            conn = activeConn
            activeConn = null
            thread?.interrupt()
            if (!stop.get()) {
                thread = Thread({ runLoop(nextGen) }, "h264-$nextGen").apply { isDaemon = true; start() }
            }
        }
        if (conn != null) {
            Thread({
                try {
                    conn.disconnect()
                } catch (_: Exception) {
                }
            }, "h264-recycle").apply { isDaemon = true; start() }
        }
    }

    private fun runLoop(gen: Long) {
        while (!stop.get() && generation.get() == gen) {
            try {
                post(gen)
            } catch (error: Exception) {
                if (stop.get() || generation.get() != gen) break
                connected = false
                this.error = "upload failed"
                log("h264 upload failed: ${error.javaClass.simpleName}")
                sleep(400)
            }
        }
        if (generation.get() == gen) {
            connected = false
        }
    }

    private fun post(gen: Long) {
        val url = URL(base.trimEnd('/') + "/api/bridge/h264")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/octet-stream")
            setRequestProperty("Connection", "close")
            doOutput = true
            setChunkedStreamingMode(8192)
            connectTimeout = 20_000
            readTimeout = 20_000
        }
        activeConn = conn
        var stream: OutputStream? = null
        try {
            stream = conn.outputStream
            while (!stop.get() && generation.get() == gen) {
                val item = box.poll(500, TimeUnit.MILLISECONDS) ?: continue
                stream.write(item)
                stream.flush()
                if (generation.get() == gen) {
                    connected = true
                    error = ""
                }
            }
            if (!stop.get() && generation.get() == gen) {
                stream.close()
                stream = null
                val status = conn.responseCode
                connected = status == 200
                error = if (status == 200) "" else "http $status"
                log("h264 upload finished http $status")
                if (status == 401) {
                    log("bridge token was rejected")
                    stop.set(true)
                } else if (status == 409) {
                    error = "ingest busy"
                    sleep(2000)
                }
            }
        } finally {
            if (activeConn === conn) activeConn = null
            try {
                stream?.close()
            } catch (_: Exception) {
            }
            conn.disconnect()
            if (generation.get() == gen) {
                connected = false
            }
        }
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
