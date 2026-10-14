package com.operator.bridge.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!BridgeStore.autoStart(context) || !BridgeStore.running(context)) return
        BridgeForegroundService.start(context)
    }
}
