package com.operator.bridge.net

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class ConsoleClient(
    private val base: String,
    private val token: String,
) {
    class HttpStatus(val code: Int, val body: String) : Exception("http $code")

    fun get(path: String): JSONObject = request("GET", path, null)

    fun post(path: String, payload: JSONObject): JSONObject = request("POST", path, payload)

    private fun request(method: String, path: String, payload: JSONObject?): JSONObject {
        val url = URL(base.trimEnd('/') + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 8_000
            readTimeout = if (method == "GET") 15_000 else 8_000
        }
        try {
            if (payload != null) {
                val bytes = payload.toString().toByteArray(Charsets.UTF_8)
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(bytes) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let { BufferedReader(InputStreamReader(it)).use { reader -> reader.readText() } }.orEmpty()
            if (code !in 200..299) throw HttpStatus(code, text.take(300))
            if (text.isBlank()) return JSONObject()
            return JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
