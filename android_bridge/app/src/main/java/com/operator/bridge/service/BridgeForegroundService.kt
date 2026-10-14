package com.operator.bridge.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.operator.bridge.R
import com.operator.bridge.diag.DiagnosticRecorder
import com.operator.bridge.engine.BridgeSnapshot
import com.operator.bridge.engine.LookCamEngine
import com.operator.bridge.net.HotspotNetworkFinder
import com.operator.bridge.ui.MainActivity
import java.util.concurrent.CopyOnWriteArrayList

object BridgeRuntime {
    @Volatile var recorder: DiagnosticRecorder? = null
    @Volatile var snapshot = BridgeSnapshot()
    private val listeners = CopyOnWriteArrayList<(BridgeSnapshot) -> Unit>()

    fun listen(listener: (BridgeSnapshot) -> Unit) {
        listeners.add(listener)
        listener(snapshot)
    }

    fun unlisten(listener: (BridgeSnapshot) -> Unit) {
        listeners.remove(listener)
    }

    fun update(next: BridgeSnapshot) {
        snapshot = next
        listeners.forEach { listener ->
            try {
                listener(next)
            } catch (_: Exception) {
            }
        }
    }
}

class BridgeForegroundService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var multicast: WifiManager.MulticastLock? = null
    private var engine: LookCamEngine? = null
    private var worker: Thread? = null
    private var recorder: DiagnosticRecorder? = null
    private var lastNotify = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopBridge()
                return START_NOT_STICKY
            }
            ACTION_RECONNECT -> engine?.requestReconnect()
            else -> startBridge()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        engine?.shutdown()
        recorder?.log("service destroyed")
        recorder?.close()
        if (BridgeRuntime.recorder === recorder) BridgeRuntime.recorder = null
        super.onDestroy()
    }

    private fun startBridge() {
        if (worker?.isAlive == true) return
        val config = BridgeStore.config(this)
        val log = recorder ?: DiagnosticRecorder(this).also {
            recorder = it
            BridgeRuntime.recorder = it
        }
        log.setSecrets(listOf(config.token))
        log.log("service start url=${config.url} device=${config.device}")
        acquireLocks(log)
        startInForeground(notification(BridgeSnapshot(running = true, phase = "starting", detail = "Starting")))
        BridgeStore.setRunning(this, true)
        val next = LookCamEngine(
            config,
            log,
            onSnapshot = { snapshot ->
                BridgeRuntime.update(snapshot)
                if (snapshot.camera.count { it == '.' } == 3) BridgeStore.rememberCamera(this, snapshot.camera)
                val now = System.currentTimeMillis()
                if (now - lastNotify > 1000) {
                    lastNotify = now
                    notify(snapshot)
                }
            },
            onCameraIp = { ip -> BridgeStore.rememberCamera(this, ip) },
        )
        engine = next
        worker = Thread({
            try {
                next.start()
            } catch (error: Exception) {
                log.log(error, "engine crashed")
                BridgeRuntime.update(BridgeSnapshot(phase = "failed", detail = error.message ?: "engine crashed"))
            } finally {
                BridgeStore.setRunning(this, false)
                stopForeground(STOP_FOREGROUND_DETACH)
                stopSelf()
            }
        }, "lookcam-engine").apply { start() }
    }

    private fun stopBridge() {
        BridgeStore.setRunning(this, false)
        recorder?.log("stop requested")
        engine?.shutdown()
        worker?.join(1500)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireLocks(log: DiagnosticRecorder) {
        val power = getSystemService(PowerManager::class.java)
        wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lookcam:bridge").apply {
            setReferenceCounted(false)
            acquire()
        }
        val wifiManager = applicationContext.getSystemService(WifiManager::class.java)
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifi = wifiManager.createWifiLock(mode, "lookcam:bridge").apply {
            setReferenceCounted(false)
            acquire()
        }
        multicast = wifiManager.createMulticastLock("lookcam:bridge").apply {
            setReferenceCounted(false)
            acquire()
        }
        log.log("wake and wifi locks acquired")
        log.log(HotspotNetworkFinder.scan().summary)
    }

    private fun releaseLocks() {
        listOf(wake, wifi, multicast).forEach { lock ->
            try {
                when (lock) {
                    is PowerManager.WakeLock -> if (lock.isHeld) lock.release()
                    is WifiManager.WifiLock -> if (lock.isHeld) lock.release()
                    is WifiManager.MulticastLock -> if (lock.isHeld) lock.release()
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun notify(snapshot: BridgeSnapshot) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTE_ID, notification(snapshot))
    }

    private fun startInForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTE_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTE_ID, notification)
        }
    }

    private fun notification(snapshot: BridgeSnapshot): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                    description = getString(R.string.channel_desc)
                    setShowBadge(false)
                },
            )
        }
        val open = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            2,
            Intent(this, BridgeForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val reconnect = PendingIntent.getService(
            this,
            3,
            Intent(this, BridgeForegroundService::class.java).setAction(ACTION_RECONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("LookCam ${snapshot.phase}")
            .setContentText(snapshot.detail)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Reconnect", reconnect)
            .addAction(0, "Stop", stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.operator.bridge.STOP"
        const val ACTION_RECONNECT = "com.operator.bridge.RECONNECT"
        private const val CHANNEL = "lookcam-bridge"
        private const val NOTE_ID = 42

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, BridgeForegroundService::class.java))
        }
    }
}
