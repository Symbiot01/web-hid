package com.operator.bridge.engine

import com.operator.bridge.diag.DiagnosticRecorder
import com.operator.bridge.net.ConsoleClient
import com.operator.bridge.net.H264ChunkedUploader
import com.operator.bridge.net.HotspotNetworkFinder
import com.operator.bridge.protocol.LookCamProtocol
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class BridgeConfig(
    val url: String,
    val token: String,
    val device: String,
    val pinnedIp: String,
    val lastIp: String,
)

data class BridgeSnapshot(
    val running: Boolean = false,
    val phase: String = "idle",
    val detail: String = "Stopped",
    val attempt: Int = 0,
    val hotspot: String = "—",
    val camera: String = "—",
    val console: String = "—",
    val video: String = "off",
    val videoBytes: Long = 0,
    val rxPackets: Long = 0,
    val txPackets: Long = 0,
    val gaps: Long = 0,
    val uploadQueue: Int = 0,
    val uploadConnected: Boolean = false,
)

private class Pending(
    val id: String?,
    val name: String,
    val body: JSONObject,
    val kind: String,
    val needJson: Boolean,
    val index: Int,
    var tries: Int,
    var sent: Double,
    var acked: Boolean,
    val args: JSONObject,
)

class LookCamEngine(
    private val config: BridgeConfig,
    private val recorder: DiagnosticRecorder,
    private val onSnapshot: (BridgeSnapshot) -> Unit,
    private val onCameraIp: (String) -> Unit,
) {
    private val stop = AtomicBoolean(false)
    private val lock = Any()
    private val commands = ArrayDeque<JSONObject>()
    private val outbox = ArrayBlockingQueue<Pair<String, JSONObject>>(32)
    private val uploader = H264ChunkedUploader(config.url, config.token, recorder::log)
    private val client = ConsoleClient(config.url, config.token)

    private val uid = LookCamProtocol.packUid(config.device)
    @Volatile private var videoDesired = false
    @Volatile private var streamNo = 2
    @Volatile private var configured = false
    @Volatile private var password = ""
    private var passwordChanged = false
    private var forceReconnect = false
    private var attempt = 1
    private var phase = "searching"
    private var detail = "looking for the camera"
    private var console = "connecting"
    private var peer: InetSocketAddress? = null
    private var ready = false
    private var loginOk = false
    private var clockOk = false
    private var videoOpen = false
    private var openedStream = 2
    private var videoNext: Int? = null
    private val videoBuf = HashMap<Int, ByteArray>()
    private var gapSince = 0.0
    private var videoBytes = 0L
    private var lastVideo = 0.0
    private var videoOpenedAt = 0.0
    private var lastRx = mono()
    private var lastSearch = 0.0
    private var lastPunch = 0.0
    private var lastAlive = 0.0
    private var peerSince = 0.0
    private var cmdIdx = 0
    private var userId = 1
    private var pending: Pending? = null
    private var stalls = 0
    private var nextVideoTry = 0.0
    private var rediscoverAt = 0.0
    private var backoffUntil = 0.0
    private var lastSweep = 0.0
    private var lastTargetsAt = 0.0
    private var targets = HotspotNetworkFinder.scan()
    private var rxPackets = 0L
    private var txPackets = 0L
    private var gaps = 0L
    private var hotspotLabel = targets.summary.take(80)
    private lateinit var socket: DatagramSocket

    fun start() {
        LookCamProtocol.runSelfTest()
        recorder.log("protocol self-test passed device=${config.device}")
        if (config.token.length < 16) {
            recorder.log("bridge token missing")
            publish("token", "Bridge token is required")
            return
        }
        socket = DatagramSocket(null).apply {
            reuseAddress = true
            broadcast = true
            try {
                receiveBufferSize = 4 * 1024 * 1024
            } catch (error: Exception) {
                recorder.log("receive buffer left at default: ${error.javaClass.simpleName}")
            }
            bind(InetSocketAddress(0))
            soTimeout = 100
        }
        recorder.log("udp bound ${socket.localAddress.hostAddress}:${socket.localPort}")
        recorder.log("discovery ${targets.summary}")
        Thread({ pollLoop() }, "bridge-poll").apply { isDaemon = true; start() }
        Thread({ reportLoop() }, "bridge-report").apply { isDaemon = true; start() }
        var lastStatus = 0.0
        var lastTelemetry = 0.0
        try {
            while (!stop.get()) {
                val now = mono()
                housekeeping(now)
                if (now - lastStatus > 3) {
                    pushStatus()
                    lastStatus = now
                }
                if (now - lastTelemetry > 5) {
                    recorder.log(
                        "telemetry phase=$phase rx=$rxPackets tx=$txPackets bytes=$videoBytes gaps=$gaps buffered=${videoBuf.size} queue=${uploader.queued} console=$console hotspot=$hotspotLabel",
                    )
                    lastTelemetry = now
                }
                receive()
            }
        } finally {
            uploader.halt()
            socket.close()
            recorder.log("engine stopped")
            publish(phase, detail)
        }
    }

    fun shutdown() {
        stop.set(true)
    }

    fun requestReconnect() {
        synchronized(lock) { forceReconnect = true }
        recorder.log("reconnect requested from the phone")
    }

    private fun receive() {
        val buf = ByteArray(65535)
        val packet = DatagramPacket(buf, buf.size)
        try {
            socket.receive(packet)
        } catch (_: SocketTimeoutException) {
            return
        } catch (_: SocketException) {
            return
        }
        rxPackets += 1
        val data = packet.data.copyOfRange(packet.offset, packet.offset + packet.length)
        onPacket(data, InetSocketAddress(packet.address, packet.port))
    }

    private fun housekeeping(now: Double) {
        if (videoOpen && videoBuf.isNotEmpty() && gapSince > 0 && now - gapSince >= 0.18) {
            val expected = videoNext
            if (expected != null) {
                videoNext = videoBuf.keys.minBy { (it - expected) and 0xFFFF }
                recorder.log("gap timeout skip $expected -> $videoNext buffered=${videoBuf.size}")
                gaps += 1
            }
            gapSince = 0.0
            drainVideo(now)
        }
        if (rediscoverAt > 0 && now >= rediscoverAt) {
            rediscoverAt = 0.0
            reset("camera changed network")
            return
        }
        val current = peer
        if (current != null && now - lastRx > 12) {
            reset("session went quiet")
            return
        }
        if (current == null && now >= backoffUntil && now - lastSearch > 0.4) {
            refreshTargets(now)
            search()
            lastSearch = now
            setPhase("searching", "looking for the camera")
        }
        if (current != null && !ready && now - lastPunch > 0.25) {
            send(LookCamProtocol.pppp(0x41, uid), current)
            lastPunch = now
            setPhase("punching", "waiting for ready")
        }
        if (current != null && !ready && now - peerSince > 4) {
            reset("punch timed out")
            return
        }
        if (ready && now - lastAlive > 0.8) {
            send(LookCamProtocol.pppp(0xE0), current ?: return)
            lastAlive = now
        }
        tickPending(now)
        if (pending != null) return
        if (takeReconnect()) {
            reset("reconnect requested")
            return
        }
        if (ready && !loginOk && now >= nextVideoTry) {
            if (password.isEmpty()) {
                setPhase("login", "camera password is not configured")
                nextVideoTry = now + 3
                return
            }
            begin("LoginDev", JSONObject().put("pwd", password).put("cmd", "LoginDev"), "login", true)
            return
        }
        if (loginOk && !clockOk) {
            begin(
                "AppointDev",
                JSONObject()
                    .put("state", 3)
                    .put("pwd", password)
                    .put("zone", LookCamProtocol.ZONE_HOURS)
                    .put("zone_s", LookCamProtocol.ZONE_SECONDS)
                    .put("time", System.currentTimeMillis() / 1000)
                    .put("cmd", "AppointDev"),
                "clock",
                true,
            )
            return
        }
        if (!clockOk) return
        val command = popCommand()
        if (command != null) {
            beginUser(command)
            return
        }
        val desired = videoDesired
        val stream = streamNo
        val videoAge = now - (if (lastVideo > 0) lastVideo else videoOpenedAt)
        if (videoOpen && desired && videoAge > 3.5) {
            stalls += 1
            recorder.log("video stall $stalls age=${"%.1f".format(videoAge)}s")
            if (stalls >= 4) {
                reset("video stalled")
                return
            }
            setPhase("recovering", "reopening video")
            beginVideo(2, stream)
            return
        }
        if (desired && videoOpen && stream != openedStream) {
            beginVideo(0, openedStream)
            return
        }
        if (desired && !videoOpen && now >= nextVideoTry) {
            beginVideo(2, stream)
            return
        }
        if (!desired && videoOpen) {
            beginVideo(0, openedStream)
            return
        }
        if (videoOpen && lastVideo > 0 && now - lastVideo < 2.5) setPhase("streaming", "bytes flowing")
        else if (clockOk) setPhase("ready", "session up")
    }

    private fun refreshTargets(now: Double) {
        if (now - lastTargetsAt < 2.5 && targets.subnets.isNotEmpty()) return
        targets = HotspotNetworkFinder.scan()
        lastTargetsAt = now
        hotspotLabel = targets.subnets.firstOrNull()?.let { "${it.iface} ${it.localIp}/${it.prefix}" } ?: "no hotspot subnet"
        recorder.log("discovery ${targets.summary}")
    }

    private fun search() {
        val packet = LookCamProtocol.pppp(0x30)
        val pinned = listOf(config.pinnedIp, config.lastIp).filter { HotspotNetworkFinder.reachable(it) }
        for (ip in (pinned + targets.neighbors).distinct()) sendTo(packet, ip, LookCamProtocol.SEARCH_PORT)
        for (ip in targets.broadcasts) sendTo(packet, ip, LookCamProtocol.SEARCH_PORT)
        val now = mono()
        if (now - lastSweep < 2.5) return
        lastSweep = now
        var sent = 0
        for (subnet in targets.subnets) {
            for (ip in subnet.hosts) {
                sendTo(packet, ip, LookCamProtocol.SEARCH_PORT)
                sent += 1
            }
            recorder.log("sweep ${subnet.iface} ${subnet.localIp}/${subnet.prefix} probes=${subnet.hosts.size}")
        }
        if (sent == 0) recorder.log("sweep skipped, no /24 hotspot subnet")
    }

    private fun tickPending(now: Double) {
        val item = pending ?: return
        val age = now - item.sent
        if (!item.acked && age > 1.2) {
            if (item.tries >= 4) finish(false, "no acknowledgement", null)
            else transmit()
        } else if (item.needJson && item.acked && age > 2.5) {
            if (item.tries >= 4) finish(false, "no reply", null)
            else {
                item.acked = false
                transmit()
            }
        }
    }

    private fun begin(name: String, body: JSONObject, kind: String, needJson: Boolean) {
        pending = Pending(null, name, body, kind, needJson, nextIndex(), 0, 0.0, false, JSONObject())
        if (kind == "login") setPhase("login", "LoginDev")
        else if (kind == "clock") setPhase("clock", "setting the clock")
        transmit()
    }

    private fun beginVideo(state: Int, stream: Int) {
        pending = Pending(
            null,
            "OpenVideo",
            JSONObject()
                .put("state", state)
                .put("pwd", password)
                .put("stream", stream)
                .put("userid", userId)
                .put("cmd", "OpenVideo"),
            if (state == 2) "video-start" else "video-stop",
            false,
            nextIndex(),
            0,
            0.0,
            false,
            JSONObject().put("stream", stream),
        )
        userId = if (userId < 60000) userId + 1 else 1
        setPhase("opening", if (state == 2) "starting video" else "stopping video")
        recorder.log("OpenVideo state=$state stream=$stream")
        transmit()
    }

    private fun beginUser(command: JSONObject) {
        val name = command.optString("name")
        val args = command.optJSONObject("args") ?: JSONObject()
        if (name !in LookCamProtocol.ALLOWED) {
            enqueueResult(command.optString("id", ""), false, "unknown command", null)
            return
        }
        val body = cameraBody(name, args)
        if (body == null) {
            enqueueResult(command.optString("id", ""), false, "camera password is not configured", null)
            return
        }
        pending = Pending(command.optString("id"), name, body, "user", name !in LookCamProtocol.NO_REPLY, nextIndex(), 0, 0.0, false, args)
        recorder.log("command $name")
        transmit()
    }

    private fun cameraBody(name: String, args: JSONObject): JSONObject? {
        if (name == "ModifyPwd") {
            if (password.isEmpty()) return null
            return JSONObject().put("pwd", password).put("newpwd", args.optString("newpwd")).put("cmd", name)
        }
        if (name == "OpenWifi") {
            return JSONObject().put("sid", args.optString("sid")).put("wifiPwd", args.optString("wifiPwd")).put("state", 1).put("cmd", name)
        }
        val body = JSONObject()
        val keys = args.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            body.put(key, args.get(key))
        }
        body.put("cmd", name)
        return body
    }

    private fun transmit() {
        val item = pending ?: return
        val target = peer ?: return
        val raw = item.body.toString()
        send(LookCamProtocol.drw(1, item.index, LookCamProtocol.encodeJson(raw)), target)
        item.tries += 1
        item.sent = mono()
    }

    private fun finish(ok: Boolean, detailText: String, msg: JSONObject?) {
        val item = pending ?: return
        pending = null
        when (item.kind) {
            "login" -> {
                val result = if (msg != null && msg.has("result")) msg.optInt("result") else null
                loginOk = ok && result == 0
                recorder.log("login result=$result")
                if (!loginOk) {
                    nextVideoTry = mono() + minOf(15.0, 3.0 * maxOf(1, attempt))
                    setPhase("login", "login was rejected")
                }
            }
            "clock" -> {
                val state = if (msg != null && msg.has("state")) msg.optInt("state") else null
                clockOk = ok && state == 0
                recorder.log("appoint state=$state")
                if (!clockOk) loginOk = false
            }
            "video-start" -> {
                if (ok) {
                    val stream = item.args.optInt("stream", 2)
                    if (!videoOpen || openedStream != stream) {
                        videoNext = null
                        videoBuf.clear()
                        gapSince = 0.0
                    }
                    videoOpen = true
                    openedStream = stream
                    videoOpenedAt = mono()
                    stalls = 0
                } else {
                    nextVideoTry = mono() + 2
                }
            }
            "video-stop" -> {
                if (ok) {
                    videoOpen = false
                    uploader.halt()
                } else {
                    nextVideoTry = mono() + 2
                }
            }
            else -> {
                if (item.kind != "user") {
                    if (!ok) nextVideoTry = mono() + 2
                    return
                }
                var text = detailText
                if (item.name == "ModifyPwd" && msg?.optInt("result") == 0) {
                    val next = item.args.optString("newpwd")
                    if (next.isNotEmpty()) {
                        password = next
                        passwordChanged = true
                    }
                }
                if (item.name == "OpenWifi" && ok) {
                    rediscoverAt = mono() + 1.5
                    text = "camera is joining the network"
                }
                if (item.name in LookCamProtocol.NO_REPLY && ok) text = "Acknowledged. The camera sent no JSON."
                recorder.log("${item.name} ${if (ok) "ok" else "failed"} $text")
                enqueueResult(item.id ?: "", ok, text, LookCamProtocol.publicBody(msg))
            }
        }
    }

    private fun onPacket(data: ByteArray, addr: InetSocketAddress) {
        if (data.size < 4 || data[0] != 0xF1.toByte()) return
        val declared = ((data[2].toInt() and 0xFF) shl 8) or (data[3].toInt() and 0xFF)
        if (declared > 60_000 || data.size < 4 + declared) return
        val body = data.copyOfRange(4, 4 + declared)
        val type = data[1].toInt() and 0xFF
        val known = peer
        if (known != null && addr.address.hostAddress != known.address.hostAddress) return
        if (type == 0x41 && body.size >= 20 && body.copyOfRange(0, 20).contentEquals(uid) && !ready) {
            peer = addr
            peerSince = mono()
            lastRx = peerSince
            send(LookCamProtocol.pppp(0x41, uid), addr)
            lastPunch = mono()
            val ip = addr.address.hostAddress ?: ""
            recorder.log("punch from $ip:${addr.port}")
            if (ip.isNotEmpty()) onCameraIp(ip)
            return
        }
        if (type == 0x42 && (body.size >= 20 && body.copyOfRange(0, 20).contentEquals(uid) || known != null && addr.address.hostAddress == known.address.hostAddress)) {
            lastRx = mono()
            if (!ready) {
                peer = addr
                ready = true
                recorder.log("session ready ${addr.port}")
                send(LookCamProtocol.pppp(0xE0), addr)
                send(LookCamProtocol.drwAck(7, 0xAAAA), addr)
                lastAlive = mono()
            }
            return
        }
        if (known == null || addr.address.hostAddress != known.address.hostAddress) return
        lastRx = mono()
        when (type) {
            0xE0 -> send(LookCamProtocol.pppp(0xE1), addr)
            0xF0 -> reset("camera closed the session")
            0xD1 -> if (body.size >= 4 && body[0] == 0xD1.toByte()) {
                val channel = body[1].toInt() and 0xFF
                val index = if (body.size >= 6 && body[2].toInt() == 0 && body[3].toInt() == 1) {
                    ((body[4].toInt() and 0xFF) shl 8) or (body[5].toInt() and 0xFF)
                } else {
                    ((body[2].toInt() and 0xFF) shl 8) or (body[3].toInt() and 0xFF)
                }
                val item = pending
                if (item != null && channel == 1 && index == item.index) {
                    item.acked = true
                    if (!item.needJson) finish(true, "acknowledged", null)
                }
            }
            0xD0 -> if (body.size >= 4 && body[0] == 0xD1.toByte()) {
                val channel = body[1].toInt() and 0xFF
                val index = ((body[2].toInt() and 0xFF) shl 8) or (body[3].toInt() and 0xFF)
                val payload = body.copyOfRange(4, body.size)
                send(LookCamProtocol.drwAck(channel, index), addr)
                if (channel == 1) {
                    val msg = LookCamProtocol.parseJson(payload)
                    val item = pending
                    if (msg != null && item != null && msg.optString("cmd") == item.name) finish(true, "ok", msg)
                } else if (channel == 0 && videoOpen) {
                    takeVideo(index, payload)
                }
            }
        }
    }

    private fun takeVideo(index: Int, payload: ByteArray) {
        if (videoNext == null) videoNext = index
        val expected = videoNext ?: return
        val diff = (index - expected) and 0xFFFF
        if (diff >= 0x8000) return
        if (videoBuf.containsKey(index)) return
        videoBuf[index] = payload
        val now = mono()
        if (!videoBuf.containsKey(expected)) {
            if (gapSince == 0.0) gapSince = now
            if (videoBuf.size >= 12 || now - gapSince >= 0.18) {
                val next = videoBuf.keys.minBy { (it - expected) and 0xFFFF }
                recorder.log("gap skip $expected -> $next buffered=${videoBuf.size}")
                videoNext = next
                gapSince = 0.0
                gaps += 1
            }
        } else {
            gapSince = 0.0
        }
        drainVideo(now)
    }

    private fun drainVideo(now: Double) {
        while (videoNext != null && videoBuf.containsKey(videoNext)) {
            val body = videoBuf.remove(videoNext) ?: break
            val chunk = if (body.size > LookCamProtocol.VIDEO_HEADER && body.copyOfRange(0, 4).contentEquals(LookCamProtocol.FRAME_MARK)) {
                body.copyOfRange(LookCamProtocol.VIDEO_HEADER, body.size)
            } else {
                body
            }
            if (chunk.isNotEmpty()) {
                videoBytes += chunk.size
                lastVideo = now
                stalls = 0
                attempt = 1
                if (videoDesired) {
                    uploader.offer(chunk)
                    uploader.ensure()
                }
            }
            videoNext = ((videoNext ?: 0) + 1) and 0xFFFF
        }
        val expected = videoNext
        if (videoBuf.isNotEmpty() && expected != null) {
            val stale = videoBuf.keys.filter { ((it - expected) and 0xFFFF) >= 0x8000 }
            stale.forEach { videoBuf.remove(it) }
        }
        if (videoBuf.isEmpty()) gapSince = 0.0
        else if (gapSince == 0.0) gapSince = now
    }

    private fun reset(reason: String) {
        attempt += 1
        val delay = minOf(8.0, 0.4 * (1 shl minOf(attempt, 4)))
        peer = null
        ready = false
        loginOk = false
        clockOk = false
        videoOpen = false
        openedStream = 2
        videoNext = null
        videoBuf.clear()
        gapSince = 0.0
        videoBytes = 0
        lastVideo = 0.0
        videoOpenedAt = 0.0
        lastRx = mono()
        cmdIdx = 0
        userId = 1
        pending = null
        stalls = 0
        nextVideoTry = 0.0
        uploader.halt()
        backoffUntil = mono() + delay
        setPhase("searching", reason)
        recorder.log("recover attempt=$attempt $reason delay=${"%.1f".format(delay)}s")
    }

    private fun setPhase(next: String, text: String) {
        if (next == phase && text == detail) return
        phase = next
        detail = text
        recorder.log("phase $next $text")
        publish(next, text)
    }

    private fun publish(next: String, text: String) {
        val video = when {
            !videoDesired -> "off"
            videoOpen && lastVideo > 0 && mono() - lastVideo < 2.5 -> "on"
            else -> "starting"
        }
        val camera = peer?.address?.hostAddress ?: "searching"
        onSnapshot(
            BridgeSnapshot(
                running = !stop.get(),
                phase = next,
                detail = text,
                attempt = attempt,
                hotspot = hotspotLabel,
                camera = camera,
                console = console,
                video = video,
                videoBytes = videoBytes,
                rxPackets = rxPackets,
                txPackets = txPackets,
                gaps = gaps,
                uploadQueue = uploader.queued,
                uploadConnected = uploader.connected,
            ),
        )
    }

    private fun pushStatus() {
        val video = when {
            !videoDesired -> "off"
            videoOpen && lastVideo > 0 && mono() - lastVideo < 2.5 -> "on"
            else -> "starting"
        }
        val checks = JSONArray()
            .put(check("search", peer != null || ready, if (peer != null) "found" else "searching"))
            .put(check("session", ready, if (ready) "ready" else detail.take(80)))
            .put(check("login", loginOk, if (loginOk) "result 0" else detail.take(80)))
            .put(check("clock", clockOk, if (clockOk) "set" else "waiting"))
            .put(check("video", video == "on", if (videoBytes > 0) "$videoBytes bytes" else video))
        putOutbox(
            "/api/bridge/status",
            JSONObject()
                .put("phase", phase)
                .put("attempt", attempt)
                .put("detail", detail)
                .put("video", video)
                .put("checks", checks)
                .put("needsPassword", !configured),
        )
        publish(phase, detail)
    }

    private fun check(name: String, ok: Boolean, text: String) =
        JSONObject().put("name", name).put("ok", ok).put("detail", text)

    private fun pollLoop() {
        while (!stop.get()) {
            try {
                val payload = client.get("/api/bridge/poll?wait=8")
                console = "online"
                val list = payload.optJSONArray("commands")
                synchronized(lock) {
                    videoDesired = payload.optBoolean("video", false)
                    val next = payload.optInt("stream", streamNo)
                    if (next == 2 || next == 3) streamNo = next
                }
                if (list == null) continue
                for (i in 0 until list.length()) {
                    val command = list.optJSONObject(i) ?: continue
                    when (command.optString("op")) {
                        "configure" -> configure(command)
                        "reconnect" -> {
                            synchronized(lock) { forceReconnect = true }
                            enqueueResult(command.optString("id"), true, "reconnecting", null)
                        }
                        "call" -> {
                            var busy = false
                            synchronized(lock) {
                                if (commands.size >= 8) busy = true else commands.add(command)
                            }
                            if (busy) enqueueResult(command.optString("id"), false, "bridge is busy", null)
                        }
                    }
                }
            } catch (error: ConsoleClient.HttpStatus) {
                if (error.code == 401) {
                    console = "token rejected"
                    recorder.log("bridge token was rejected")
                    stop.set(true)
                    return
                }
                console = "http ${error.code}"
                recorder.log("poll http ${error.code}")
                sleep(if (error.code == 409) 2000 else 1500)
            } catch (error: Exception) {
                console = "offline"
                recorder.log("poll failed: ${error.javaClass.simpleName}")
                sleep(2000)
            }
        }
    }

    private fun reportLoop() {
        while (!stop.get()) {
            val item = outbox.poll(500, TimeUnit.MILLISECONDS) ?: continue
            for (tryNum in 1..3) {
                try {
                    client.post(item.first, item.second)
                    break
                } catch (error: ConsoleClient.HttpStatus) {
                    if (error.code == 401) {
                        console = "token rejected"
                        recorder.log("bridge token was rejected")
                        stop.set(true)
                        return
                    }
                    sleep(400)
                } catch (_: Exception) {
                    sleep(400)
                }
                if (tryNum == 3) recorder.log("result post failed ${item.first}")
            }
        }
    }

    private fun configure(command: JSONObject) {
        val next = command.optString("password")
        synchronized(lock) {
            if (next.isNotEmpty() && !passwordChanged) password = next
            configured = true
        }
        recorder.log("camera password configured=${next.isNotEmpty()}")
        enqueueResult(command.optString("id"), true, "configured", null)
    }

    private fun enqueueResult(id: String, ok: Boolean, text: String, body: JSONObject?) {
        if (id.isEmpty()) return
        putOutbox("/api/bridge/result", JSONObject().put("id", id).put("ok", ok).put("detail", text).put("body", body ?: JSONObject.NULL))
    }

    private fun putOutbox(path: String, payload: JSONObject) {
        if (!outbox.offer(path to payload)) {
            outbox.poll()
            outbox.offer(path to payload)
        }
    }

    private fun popCommand(): JSONObject? = synchronized(lock) { if (commands.isEmpty()) null else commands.removeFirst() }

    private fun takeReconnect(): Boolean = synchronized(lock) {
        if (!forceReconnect) return false
        forceReconnect = false
        true
    }

    private fun send(packet: ByteArray, target: InetSocketAddress) {
        sendTo(packet, target.address.hostAddress ?: return, target.port)
    }

    private fun sendTo(packet: ByteArray, host: String, port: Int) {
        try {
            socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName(host), port))
            txPackets += 1
        } catch (error: Exception) {
            if (port != LookCamProtocol.SEARCH_PORT) recorder.log("send error ${error.javaClass.simpleName} $host:$port")
        }
    }

    private fun nextIndex(): Int {
        val index = cmdIdx
        cmdIdx = (cmdIdx + 1) and 0xFFFF
        return index
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun mono(): Double = System.nanoTime() / 1_000_000_000.0
}
