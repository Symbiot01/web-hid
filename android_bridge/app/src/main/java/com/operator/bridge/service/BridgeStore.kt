package com.operator.bridge.service

import android.content.Context
import com.operator.bridge.BuildConfig
import com.operator.bridge.engine.BridgeConfig

object BridgeStore {
    private const val NAME = "bridge"
    private const val URL = "url"
    private const val TOKEN = "token"
    private const val DEVICE = "device"
    private const val PINNED = "pinned"
    private const val LAST = "last"
    private const val RUNNING = "running"
    private const val AUTO = "auto"

    private fun prefs(context: Context) = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun config(context: Context): BridgeConfig {
        val prefs = prefs(context)
        return BridgeConfig(
            url = prefs.getString(URL, BuildConfig.DEFAULT_URL).orEmpty().ifBlank { BuildConfig.DEFAULT_URL },
            token = prefs.getString(TOKEN, "").orEmpty().trim(),
            device = prefs.getString(DEVICE, BuildConfig.DEFAULT_DEVICE).orEmpty().ifBlank { BuildConfig.DEFAULT_DEVICE },
            pinnedIp = prefs.getString(PINNED, "").orEmpty().trim(),
            lastIp = prefs.getString(LAST, "").orEmpty().trim(),
        )
    }

    fun save(context: Context, url: String, token: String, device: String, pinnedIp: String, autoStart: Boolean) {
        prefs(context).edit()
            .putString(URL, url.trim())
            .putString(TOKEN, token.trim())
            .putString(DEVICE, device.trim())
            .putString(PINNED, pinnedIp.trim())
            .putBoolean(AUTO, autoStart)
            .apply()
    }

    fun rememberCamera(context: Context, ip: String) {
        if (ip.isBlank()) return
        prefs(context).edit().putString(LAST, ip).apply()
    }

    fun setRunning(context: Context, running: Boolean) {
        prefs(context).edit().putBoolean(RUNNING, running).apply()
    }

    fun running(context: Context) = prefs(context).getBoolean(RUNNING, false)

    fun autoStart(context: Context) = prefs(context).getBoolean(AUTO, false)
}
