package com.operator.bridge.ui

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.method.ScrollingMovementMethod
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
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
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private var appliedResult = 0L

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
        findViewById<TextView>(R.id.resultText).movementMethod = ScrollingMovementMethod.getInstance()

        findViewById<Button>(R.id.settingsButton).setOnClickListener { toggle(R.id.settingsPanel) }
        findViewById<Button>(R.id.moreButton).setOnClickListener { toggle(R.id.morePanel) }
        findViewById<Button>(R.id.startButton).setOnClickListener { toggleBridge() }
        findViewById<Button>(R.id.reconnectButton).setOnClickListener {
            val engine = BridgeRuntime.engine
            if (engine == null) toast("Start the bridge first")
            else engine.requestReconnect()
        }
        findViewById<Button>(R.id.followButton).setOnClickListener { hold(0) }
        findViewById<Button>(R.id.holdOnButton).setOnClickListener { hold(1) }
        findViewById<Button>(R.id.holdOffButton).setOnClickListener { hold(2) }
        findViewById<Button>(R.id.streamFollowButton).setOnClickListener { stream(0) }
        findViewById<Button>(R.id.stream2Button).setOnClickListener { stream(2) }
        findViewById<Button>(R.id.stream3Button).setOnClickListener { stream(3) }

        command(R.id.cmdDevice, "GetDevInfo")
        command(R.id.cmdStream, "GetDevStream")
        command(R.id.cmdVideoInfo, "GetDevVideoInfo")
        command(R.id.cmdAlarmInfo, "GetAlarmInfo")
        command(R.id.cmdLedInfo, "GetLedInfo")
        command(R.id.cmdScan, "searchWiFiList")
        command(R.id.cmdFlipH, "LevelFlip")
        command(R.id.cmdFlipV, "VerticalFlip")
        command(R.id.cmdLedOn, "SetLed", JSONObject().put("ledstatus", 1))
        command(R.id.cmdLedOff, "SetLed", JSONObject().put("ledstatus", 0))

        val brightness = findViewById<SeekBar>(R.id.brightness)
        val saturation = findViewById<SeekBar>(R.id.saturation)
        brightness.setOnSeekBarChangeListener(labelSeek(R.id.brightnessLabel, "Brightness"))
        saturation.setOnSeekBarChangeListener(labelSeek(R.id.saturationLabel, "Saturation"))
        findViewById<Button>(R.id.applyPicture).setOnClickListener {
            send(
                "SetDevVideoInfo",
                JSONObject()
                    .put("brightness", brightness.progress)
                    .put("saturation", saturation.progress),
            )
        }
        findViewById<Button>(R.id.saveAlarm).setOnClickListener { saveAlarm() }
        findViewById<Button>(R.id.saveLed).setOnClickListener { saveLed() }
        findViewById<Button>(R.id.joinWifi).setOnClickListener { confirmWifi() }
        findViewById<Button>(R.id.changePassword).setOnClickListener { confirmPassword() }
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

    private fun toggle(id: Int) {
        val panel = findViewById<View>(id)
        panel.visibility = if (panel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun toggleBridge() {
        if (BridgeRuntime.snapshot.running) {
            AlertDialog.Builder(this)
                .setTitle("Stop background work")
                .setMessage("Video pauses, then the bridge stops. The wake lock and notification are released.")
                .setPositiveButton("Stop") { _, _ ->
                    startService(Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_STOP))
                }
                .setNegativeButton("Cancel", null)
                .show()
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
            findViewById<View>(R.id.settingsPanel).visibility = View.VISIBLE
            return
        }
        if (device.split("-").size != 3) {
            toast("Camera id looks like GHBB-522328-BWDTT")
            return
        }
        BridgeStore.save(this, url, token, device, ip, findViewById<CheckBox>(R.id.autoStart).isChecked)
        BridgeForegroundService.start(this)
    }

    private fun hold(mode: Int) {
        val engine = BridgeRuntime.engine
        if (engine == null) toast("Start the bridge first")
        else engine.setVideoHold(mode)
    }

    private fun stream(value: Int) {
        val engine = BridgeRuntime.engine
        if (engine == null) toast("Start the bridge first")
        else engine.setStreamHold(value)
    }

    private fun command(id: Int, name: String, args: JSONObject = JSONObject()) {
        findViewById<Button>(id).setOnClickListener { send(name, args) }
    }

    private fun send(name: String, args: JSONObject = JSONObject()) {
        val engine = BridgeRuntime.engine
        if (engine == null) {
            toast("Start the bridge first")
            return
        }
        val error = engine.submitLocal(name, args)
        if (error.isNotEmpty()) toast(error)
    }

    private fun saveAlarm() {
        val sensitivity = number(R.id.alarmSensitivity, 0, 10) ?: return
        val gop = number(R.id.alarmGop, 1, 120) ?: return
        val start = clock(R.id.alarmStart) ?: return
        val end = clock(R.id.alarmEnd) ?: return
        val two = clock(R.id.alarmTwo) ?: return
        val twoEnd = clock(R.id.alarmTwoEnd) ?: return
        send(
            "SetAlarmInfo",
            JSONObject()
                .put("sensitivity", sensitivity)
                .put("goptime", gop)
                .put("audio", bit(R.id.alarmAudio))
                .put("putalarm", bit(R.id.alarmPush))
                .put("osd", bit(R.id.alarmOsd))
                .put("flag", bit(R.id.alarmFlag))
                .put("starttime", start)
                .put("endtime", end)
                .put("twotime", two)
                .put("twoend", twoEnd),
        )
    }

    private fun saveLed() {
        val start = clock(R.id.ledStart) ?: return
        val end = clock(R.id.ledEnd) ?: return
        val two = clock(R.id.ledTwo) ?: return
        val twoEnd = clock(R.id.ledTwoEnd) ?: return
        send(
            "SetLedInfo",
            JSONObject()
                .put("control", bit(R.id.ledControl))
                .put("flag", bit(R.id.ledFlag))
                .put("starttime", start)
                .put("endtime", end)
                .put("twotime", two)
                .put("twoend", twoEnd),
        )
    }

    private fun confirmWifi() {
        val ssid = findViewById<EditText>(R.id.wifiSsid).text.toString()
        val password = findViewById<EditText>(R.id.wifiPassword).text.toString()
        if (ssid.isBlank() || ssid.length > 32) {
            toast("Enter a network name")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Join Wi-Fi")
            .setMessage("The camera will leave this hotspot and try to join $ssid.")
            .setPositiveButton("Join") { _, _ ->
                send("OpenWifi", JSONObject().put("sid", ssid).put("wifiPwd", password))
                findViewById<EditText>(R.id.wifiPassword).text.clear()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun confirmPassword() {
        val next = findViewById<EditText>(R.id.newPassword).text.toString()
        if (next.isEmpty() || next.length > 64) {
            toast("Enter a new camera password")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Change camera password")
            .setMessage("This changes the password stored on the camera. Update the console to match, or the next login will fail.")
            .setPositiveButton("Change") { _, _ ->
                send("ModifyPwd", JSONObject().put("newpwd", next))
                findViewById<EditText>(R.id.newPassword).text.clear()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun number(id: Int, min: Int, max: Int): Int? {
        val text = findViewById<EditText>(id).text.toString().trim()
        val value = text.toIntOrNull()
        if (value == null || value < min || value > max) {
            toast("Enter a number from $min to $max")
            return null
        }
        return value
    }

    private fun clock(id: Int): String? {
        val text = findViewById<EditText>(id).text.toString().trim()
        if (!Regex("""\d{2}:\d{2}""").matches(text)) {
            toast("Times use HH:MM")
            return null
        }
        val hour = text.substring(0, 2).toInt()
        val minute = text.substring(3, 5).toInt()
        if (hour > 23 || minute > 59) {
            toast("Times use HH:MM")
            return null
        }
        return text
    }

    private fun bit(id: Int) = if (findViewById<CheckBox>(id).isChecked) 1 else 0

    private fun labelSeek(labelId: Int, name: String) = object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
            findViewById<TextView>(labelId).text = "$name $progress"
        }

        override fun onStartTrackingTouch(seekBar: SeekBar?) {}

        override fun onStopTrackingTouch(seekBar: SeekBar?) {}
    }

    private fun render(snapshot: BridgeSnapshot) {
        findViewById<TextView>(R.id.statusDetail).text = "${snapshot.phase} · ${snapshot.detail}"
        paint(R.id.pillHotspot, "Hotspot", snapshot.hotspot, snapshot.hotspot != "—" && "no hotspot" !in snapshot.hotspot)
        paint(R.id.pillCamera, "Camera", snapshot.camera, snapshot.camera.count { it == '.' } == 3)
        paint(R.id.pillConsole, "Console", snapshot.console, snapshot.console == "online")
        val videoText = "${snapshot.video} · stream ${snapshot.stream} · ${snapshot.videoHold}"
        paint(R.id.pillVideo, "Video", videoText, snapshot.video == "on")
        findViewById<TextView>(R.id.counters).text =
            "rx ${snapshot.rxPackets}  tx ${snapshot.txPackets}  gaps ${snapshot.gaps}  upload ${snapshot.uploadQueue}" +
                if (snapshot.uploadConnected) " live" else ""
        findViewById<Button>(R.id.startButton).text = if (snapshot.running) getString(R.string.stop) else getString(R.string.start)
        mark(R.id.followButton, snapshot.videoHold == "follow")
        mark(R.id.holdOnButton, snapshot.videoHold == "on")
        mark(R.id.holdOffButton, snapshot.videoHold == "paused")
        mark(R.id.streamFollowButton, snapshot.streamHold == "follow")
        mark(R.id.stream2Button, snapshot.streamHold == "2")
        mark(R.id.stream3Button, snapshot.streamHold == "3")
        if (snapshot.resultSeq != appliedResult) {
            appliedResult = snapshot.resultSeq
            showResult(snapshot)
        }
    }

    private fun showResult(snapshot: BridgeSnapshot) {
        val view = findViewById<TextView>(R.id.resultText)
        if (snapshot.resultSeq == 0L) {
            view.text = "Command results show up here."
            return
        }
        val status = if (snapshot.lastOk) "OK" else "Failed"
        view.text = if (snapshot.lastBody.isEmpty()) {
            "$status · ${snapshot.lastCommand}\n${snapshot.lastDetail}"
        } else {
            "$status · ${snapshot.lastCommand}\n${snapshot.lastDetail}\n${snapshot.lastBody}"
        }
        val body = try {
            JSONObject(snapshot.lastBody)
        } catch (_: Exception) {
            return
        }
        when (snapshot.lastCommand) {
            "GetDevVideoInfo" -> {
                if (body.has("brightness")) findViewById<SeekBar>(R.id.brightness).progress = body.optInt("brightness").coerceIn(0, 100)
                if (body.has("saturation")) findViewById<SeekBar>(R.id.saturation).progress = body.optInt("saturation").coerceIn(0, 100)
            }
            "GetAlarmInfo" -> fillAlarm(body)
            "GetLedInfo" -> fillLed(body)
            "searchWiFiList" -> fillWifi(body.optJSONArray("value"))
        }
    }

    private fun fillAlarm(body: JSONObject) {
        setNumber(R.id.alarmSensitivity, body, "sensitivity")
        setNumber(R.id.alarmGop, body, "goptime")
        setBit(R.id.alarmAudio, body, "audio")
        setBit(R.id.alarmPush, body, "putalarm")
        setBit(R.id.alarmOsd, body, "osd")
        setBit(R.id.alarmFlag, body, "flag")
        setClock(R.id.alarmStart, body, "starttime")
        setClock(R.id.alarmEnd, body, "endtime")
        setClock(R.id.alarmTwo, body, "twotime")
        setClock(R.id.alarmTwoEnd, body, "twoend")
        findViewById<View>(R.id.morePanel).visibility = View.VISIBLE
    }

    private fun fillLed(body: JSONObject) {
        setBit(R.id.ledControl, body, "control")
        setBit(R.id.ledFlag, body, "flag")
        setClock(R.id.ledStart, body, "starttime")
        setClock(R.id.ledEnd, body, "endtime")
        setClock(R.id.ledTwo, body, "twotime")
        setClock(R.id.ledTwoEnd, body, "twoend")
        findViewById<View>(R.id.morePanel).visibility = View.VISIBLE
    }

    private fun fillWifi(value: JSONArray?) {
        val list = findViewById<LinearLayout>(R.id.wifiList)
        list.removeAllViews()
        if (value == null) return
        findViewById<View>(R.id.morePanel).visibility = View.VISIBLE
        for (i in 0 until value.length()) {
            val item = value.optJSONObject(i) ?: continue
            val ssid = item.optString("ssid")
            if (ssid.isEmpty() || ssid.length > 32 || ssid.any { it.code < 32 || it.code == 127 }) continue
            val signal = if (item.has("sig")) "  ${item.optInt("sig")}" else ""
            val button = Button(this)
            button.text = ssid + signal
            button.setTextColor(Color.parseColor("#E7EEF6"))
            button.setOnClickListener { findViewById<EditText>(R.id.wifiSsid).setText(ssid) }
            list.addView(button)
        }
    }

    private fun setNumber(id: Int, body: JSONObject, key: String) {
        if (!body.has(key)) return
        findViewById<EditText>(id).setText(body.optInt(key).toString())
    }

    private fun setBit(id: Int, body: JSONObject, key: String) {
        if (!body.has(key)) return
        findViewById<CheckBox>(id).isChecked = body.optInt(key) == 1
    }

    private fun setClock(id: Int, body: JSONObject, key: String) {
        val value = body.optString(key)
        if (Regex("""\d{2}:\d{2}""").matches(value)) findViewById<EditText>(id).setText(value)
    }

    private fun mark(id: Int, selected: Boolean) {
        findViewById<Button>(id).alpha = if (selected) 1f else 0.45f
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
