package com.operator.bridge.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

object LookCamProtocol {
    const val SEARCH_PORT = 32108
    const val ZONE_HOURS = 5
    const val ZONE_SECONDS = 19800
    const val VIDEO_HEADER = 83
    val FRAME_MARK = byteArrayOf(0x01, 0xAF.toByte(), 0xAF.toByte(), 0xAF.toByte())
    private const val EXPECTED_UID = "47484242000000000007f8584257445454000000"

    val READS = setOf(
        "GetDevInfo",
        "GetDevStream",
        "GetDevVideoInfo",
        "GetAlarmInfo",
        "GetLedInfo",
        "searchWiFiList",
    )
    val NO_REPLY = setOf("SetDevVideoInfo", "LevelFlip", "VerticalFlip", "SetLed")
    val ALLOWED = READS + NO_REPLY + setOf("SetAlarmInfo", "SetLedInfo", "OpenWifi", "ModifyPwd")

    fun packUid(device: String): ByteArray {
        val parts = device.split("-", limit = 3)
        if (parts.size != 3) throw IllegalArgumentException("bad device id")
        val serial = parts[1].toLongOrNull() ?: throw IllegalArgumentException("bad device id")
        if (serial > 0xFFFFFFFFL) throw IllegalArgumentException("bad device id")
        val raw = ByteArray(20)
        parts[0].encodeToByteArray().copyInto(raw, 0, 0, minOf(4, parts[0].length))
        ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN).putInt(8, serial.toInt())
        parts[2].encodeToByteArray().copyInto(raw, 12, 0, minOf(8, parts[2].length))
        return raw
    }

    fun pppp(type: Int, body: ByteArray = ByteArray(0)): ByteArray {
        val out = ByteArray(4 + body.size)
        out[0] = 0xF1.toByte()
        out[1] = type.toByte()
        ByteBuffer.wrap(out).order(ByteOrder.BIG_ENDIAN).putShort(2, body.size.toShort())
        body.copyInto(out, 4)
        return out
    }

    fun drw(channel: Int, index: Int, payload: ByteArray): ByteArray {
        val body = ByteArray(4 + payload.size)
        body[0] = 0xD1.toByte()
        body[1] = channel.toByte()
        ByteBuffer.wrap(body).order(ByteOrder.BIG_ENDIAN).putShort(2, (index and 0xFFFF).toShort())
        payload.copyInto(body, 4)
        return pppp(0xD0, body)
    }

    fun drwAck(channel: Int, index: Int): ByteArray {
        val body = ByteArray(6)
        body[0] = 0xD1.toByte()
        body[1] = channel.toByte()
        body[2] = 0
        body[3] = 1
        ByteBuffer.wrap(body).order(ByteOrder.BIG_ENDIAN).putShort(4, (index and 0xFFFF).toShort())
        return pppp(0xD1, body)
    }

    fun encodeJson(text: String, epochSeconds: Long = System.currentTimeMillis() / 1000): ByteArray {
        val body = text.toByteArray(Charsets.UTF_8)
        val out = ByteArray(26 + body.size + 4)
        val buf = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        buf.putInt(0xAFAFAFA0.toInt())
        out[4] = 0
        out[5] = ZONE_HOURS.toByte()
        buf.position(6)
        buf.putLong(epochSeconds + ZONE_HOURS * 3600L)
        buf.position(0x16)
        buf.putInt(body.size)
        body.copyInto(out, 26)
        buf.position(26 + body.size)
        buf.putInt(0xF1F2F3F4.toInt())
        return out
    }

    fun parseJson(payload: ByteArray): JSONObject? {
        val start = payload.indexOf(0x7B)
        val end = payload.lastIndexOf(0x7D)
        if (start < 0 || end <= start) return null
        return try {
            JSONObject(String(payload, start, end - start + 1, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    fun publicBody(msg: JSONObject?): JSONObject? {
        if (msg == null) return null
        val out = JSONObject()
        val keys = msg.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val lower = key.lowercase()
            if ("pwd" in lower || "password" in lower) continue
            val value = msg.get(key)
            if (key == "value" && value is JSONArray) {
                val clipped = JSONArray()
                for (i in 0 until minOf(40, value.length())) clipped.put(value.get(i))
                out.put(key, clipped)
            } else {
                out.put(key, value)
            }
        }
        return out
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun runSelfTest() {
        check(hex(packUid("GHBB-522328-BWDTT")) == EXPECTED_UID) { "uid" }
        check(hex(pppp(0x30)) == "f1300000") { "search" }
        val framed = encodeJson("""{"cmd":"GetDevInfo"}""", 0)
        check(hex(framed.copyOfRange(0, 4)) == "a0afafaf") { "magic" }
        check(hex(framed.copyOfRange(framed.size - 4, framed.size)) == "f4f3f2f1") { "footer" }
        val len = ByteBuffer.wrap(framed).order(ByteOrder.LITTLE_ENDIAN).getInt(0x16)
        check(len == """{"cmd":"GetDevInfo"}""".toByteArray().size) { "length" }
        val parsed = parseJson("""xx{"cmd":"GetDevInfo","pwd":"secret"}yy""".toByteArray())
        check(parsed?.optString("cmd") == "GetDevInfo") { "parse" }
        val clean = publicBody(parsed)
        check(clean != null && !clean.has("pwd") && clean.optString("cmd") == "GetDevInfo") { "redact" }
    }

    private fun ByteArray.indexOf(value: Int): Int {
        for (i in indices) if (this[i] == value.toByte()) return i
        return -1
    }

    private fun ByteArray.lastIndexOf(value: Int): Int {
        for (i in indices.reversed()) if (this[i] == value.toByte()) return i
        return -1
    }
}
