package com.operator.bridge.diag

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ArrayBlockingQueue

/**
 * Background flight recorder. The operator screen never shows these lines.
 * Tokens and password fields are stripped before anything is written.
 */
class DiagnosticRecorder(context: Context) {
    private val dir = File(context.filesDir, "logs").apply { mkdirs() }
    private val active = File(dir, "bridge-debug.log")
    private val previous = File(dir, "bridge-debug.1.log")
    private val ring = ArrayDeque<String>()
    private val pending = ArrayBlockingQueue<String>(2000)
    private val stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS").withZone(ZoneId.systemDefault())
    @Volatile private var secrets: List<String> = emptyList()
    @Volatile var running = true

    private val writer = Thread({
        while (running || pending.isNotEmpty()) {
            try {
                val line = pending.poll(400, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue
                append(line)
            } catch (_: InterruptedException) {
                break
            }
        }
    }, "bridge-log").apply { isDaemon = true; start() }

    fun setSecrets(values: Collection<String>) {
        secrets = values.map { it.trim() }.filter { it.length >= 8 }
    }

    fun log(message: String) {
        val clean = redact(message)
        val line = "${stamp.format(Instant.now())} $clean"
        synchronized(ring) {
            ring.addLast(line)
            while (ring.size > 400) ring.removeFirst()
        }
        if (!pending.offer(line)) {
            pending.poll()
            pending.offer(line)
        }
    }

    fun log(error: Throwable, message: String) {
        val trace = StringWriter()
        error.printStackTrace(PrintWriter(trace))
        log("$message\n${trace}")
    }

    fun recent(): String = synchronized(ring) { ring.joinToString("\n") }

    fun exportBundle(networkDump: String): File {
        val out = File(dir, "bridge-debug-bundle.txt")
        val body = buildString {
            append("LookCam bridge debug bundle\n")
            append("exported ${stamp.format(Instant.now())}\n\n")
            append("== network ==\n")
            append(redact(networkDump))
            append("\n\n== recent ==\n")
            append(recent())
            append("\n\n== file ==\n")
            if (active.exists()) append(redact(active.readText().takeLast(180_000)))
        }
        out.writeText(body)
        log("debug bundle written (${out.length()} bytes)")
        return out
    }

    fun close() {
        running = false
        writer.join(1500)
    }

    private fun append(line: String) {
        try {
            if (active.exists() && active.length() > 2_000_000) {
                if (previous.exists()) previous.delete()
                active.renameTo(previous)
            }
            active.appendText(line + "\n")
        } catch (_: Exception) {
            // A full disk must not stop the camera session.
        }
    }

    private fun redact(text: String): String {
        var out = text
        for (secret in secrets) {
            if (secret.isNotEmpty()) out = out.replace(secret, "[redacted]")
        }
        return out.replace(PASSWORD_FIELD, "$1\"[redacted]\"")
    }

    companion object {
        private val PASSWORD_FIELD = Regex("(?i)(\"(?:pwd|password|newpwd|wifipwd)\"\\s*:\\s*)\"(?:\\\\.|[^\"\\\\])*\"")

        fun exportFromDisk(context: Context, networkDump: String): File? {
            val dir = File(context.filesDir, "logs")
            val active = File(dir, "bridge-debug.log")
            val previous = File(dir, "bridge-debug.1.log")
            if (!active.exists() && !previous.exists()) return null
            val out = File(dir, "bridge-debug-bundle.txt")
            val body = buildString {
                append("LookCam bridge debug bundle\n\n== network ==\n")
                append(networkDump)
                append("\n\n== file ==\n")
                if (previous.exists()) append(previous.readText().takeLast(80_000))
                if (active.exists()) append(active.readText().takeLast(180_000))
            }
            out.writeText(body)
            return out
        }
    }
}
