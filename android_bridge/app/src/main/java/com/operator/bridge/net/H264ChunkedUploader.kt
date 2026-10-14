package com.operator.bridge.net

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class H264ChunkedUploader(
    private val base: String,
    private val token: String,
    private val log: (String) -> Unit,
) {
    private val box = ArrayBlockingQueue<ByteArray>(400)
    private val stop = AtomicBoolean(false)
    @Volatile private var thread: Thread? = null
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
        val current = thread
        if (current != null && current.isAlive) return
        stop.set(false)
        thread = Thread({ runLoop() }, "h264").apply { isDaemon = true; start() }
    }

    fun halt() {
        stop.set(true)
        connected = false
    }

    private fun runLoop() {
        while (!stop.get()) {
            try {
                post()
            } catch (error: Exception) {
                connected = false
                this.error = "upload failed"
                log("h264 upload failed: ${error.javaClass.simpleName}")
                sleep(400)
            }
        }
        connected = false
    }

    private fun post() {
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
        var stream: OutputStream? = null
        try {
            stream = conn.outputStream
            while (!stop.get()) {
                val item = box.poll(500, TimeUnit.MILLISECONDS) ?: continue
                stream.write(item)
                stream.flush()
                connected = true
                error = ""
            }
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
        } finally {
            try {
                stream?.close()
            } catch (_: Exception) {
            }
            conn.disconnect()
            connected = false
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
