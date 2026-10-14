package com.operator.bridge.ui

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.FileProvider
import com.operator.bridge.BuildConfig
import com.operator.bridge.R
import com.operator.bridge.diag.DiagnosticRecorder
import com.operator.bridge.engine.BridgeSnapshot
import com.operator.bridge.net.HotspotNetworkFinder
import com.operator.bridge.service.BridgeForegroundService
import com.operator.bridge.service.BridgeRuntime
import com.operator.bridge.service.BridgeStore

class MainActivity : AppCompatActivity() {
    private val listener: (BridgeSnapshot) -> Unit = { snapshot ->
        runOnUiThread { render(snapshot) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val config = BridgeStore.config(this)
        findViewById<EditText>(R.id.urlInput).setText(config.url)
        findViewById<EditText>(R.id.tokenInput).setText(config.token)
        findViewById<EditText>(R.id.deviceInput).setText(config.device.ifBlank { BuildConfig.DEFAULT_DEVICE })
        findViewById<EditText>(R.id.ipInput).setText(config.pinnedIp)
        findViewById<CheckBox>(R.id.autoStart).isChecked = BridgeStore.autoStart(this)
        findViewById<Button>(R.id.settingsButton).setOnClickListener {
            val panel = findViewById<LinearLayout>(R.id.settingsPanel)
            panel.visibility = if (panel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        findViewById<Button>(R.id.startButton).setOnClickListener { toggle() }
        findViewById<Button>(R.id.reconnectButton).setOnClickListener {
            startService(Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_RECONNECT))
        }
        findViewById<Button>(R.id.backgroundButton).setOnClickListener { askBattery() }
        findViewById<Button>(R.id.exportButton).setOnClickListener { exportDebug() }
        if (Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        render(BridgeRuntime.snapshot)
    }

    override fun onStart() {
        super.onStart()
        BridgeRuntime.listen(listener)
    }

    override fun onStop() {
        BridgeRuntime.unlisten(listener)
        super.onStop()
    }

    private fun toggle() {
        if (BridgeRuntime.snapshot.running) {
            startService(Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_STOP))
            return
        }
        val url = findViewById<EditText>(R.id.urlInput).text.toString().trim()
        val token = findViewById<EditText>(R.id.tokenInput).text.toString().trim()
        val device = findViewById<EditText>(R.id.deviceInput).text.toString().trim()
        val ip = findViewById<EditText>(R.id.ipInput).text.toString().trim()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            toast("Console URL must start with https:// or http://")
            return
        }
        if (token.length < 16) {
            toast("Bridge token is required")
            findViewById<LinearLayout>(R.id.settingsPanel).visibility = View.VISIBLE
            return
        }
        if (device.split("-").size != 3) {
            toast("Camera id looks like GHBB-522328-BWDTT")
            return
        }
        BridgeStore.save(this, url, token, device, ip, findViewById<CheckBox>(R.id.autoStart).isChecked)
        BridgeForegroundService.start(this)
    }

    private fun render(snapshot: BridgeSnapshot) {
        findViewById<TextView>(R.id.statusDetail).text = "${snapshot.phase} · ${snapshot.detail}"
        paint(R.id.pillHotspot, "Hotspot", snapshot.hotspot, snapshot.hotspot != "—" && "no hotspot" !in snapshot.hotspot)
        paint(R.id.pillCamera, "Camera", snapshot.camera, snapshot.camera.count { it == '.' } == 3)
        paint(R.id.pillConsole, "Console", snapshot.console, snapshot.console == "online")
        paint(R.id.pillVideo, "Video", "${snapshot.video} · ${snapshot.videoBytes} bytes", snapshot.video == "on")
        findViewById<TextView>(R.id.counters).text =
            "rx ${snapshot.rxPackets}  tx ${snapshot.txPackets}  gaps ${snapshot.gaps}  upload ${snapshot.uploadQueue}" +
                if (snapshot.uploadConnected) " live" else ""
        findViewById<Button>(R.id.startButton).text = if (snapshot.running) getString(R.string.stop) else getString(R.string.start)
    }

    private fun paint(id: Int, label: String, value: String, ok: Boolean) {
        val view = findViewById<TextView>(id)
        view.text = "$label  $value"
        view.setTextColor(Color.parseColor(if (ok) "#3DDC97" else "#E7EEF6"))
    }

    private fun askBattery() {
        val power = getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(packageName)) {
            toast("Background running is already allowed")
            return
        }
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    private fun exportDebug() {
        val dump = HotspotNetworkFinder.scan().summary
        val file = BridgeRuntime.recorder?.exportBundle(dump) ?: DiagnosticRecorder.exportFromDisk(this, dump)
        if (file == null) {
            toast("Start the bridge once so a debug log exists")
            return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val share = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(share, "Debug bundle"))
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }
}
