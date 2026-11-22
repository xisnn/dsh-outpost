package com.dshpocket.agent

import android.app.KeyguardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.dshpocket.agent.background.BackgroundDisplayController
import com.dshpocket.agent.background.BackgroundModeStore
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** P6-0 thin bridge: the native runtime owns the run; RN reads snapshots and decides approvals. */
class AgentModule(private val react: ReactApplicationContext) : ReactContextBaseJavaModule(react) {
    companion object {
        private const val STREAM_EVENT_NAME = "agentStream"
        private const val STREAM_THROTTLE_MS = 40L
    }

    override fun getName() = "OutpostAgent"

    private val streamListeners = AtomicInteger(0)
    private val streamLock = Any()
    private val streamMain = Handler(Looper.getMainLooper())
    private var lastStreamEmitAt = 0L
    private var pendingStreamUpdate: AgentRuntime.StreamUpdate? = null
    private val flushStream = Runnable {
        val next = synchronized(streamLock) {
            val item = pendingStreamUpdate
            pendingStreamUpdate = null
            if (item != null) lastStreamEmitAt = System.currentTimeMillis()
            item
        }
        if (next != null) emitStreamNow(next)
    }

    /** Daemon, so a pending background-display wait can never hold the process open. */
    private val startExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "dsh-agent-start").apply { isDaemon = true }
    }

    @ReactMethod
    fun snapshot(promise: Promise) {
        if (!supported()) { promise.resolve(unsupported().toString()); return }
        try {
            promise.resolve(AgentRuntime.get(react).snapshot().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun startDemo(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        if (AgentRuntime.get(react).isStorageDowngradeBlocked()) {
            promise.reject("STORAGE_DOWNGRADE_BLOCKED", "STORAGE_DOWNGRADE_BLOCKED")
            return
        }
        try {
            val intent = Intent(react, AgentService::class.java).setAction(AgentService.ACTION_RUN)
            if (Build.VERSION.SDK_INT >= 26) react.startForegroundService(intent) else react.startService(intent)
            promise.resolve(AgentRuntime.get(react).startDemo().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun startCloud(goal: String, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        if (goal.isBlank()) { promise.reject("EMPTY_GOAL", "EMPTY_GOAL"); return }
        if (AgentRuntime.get(react).isStorageDowngradeBlocked()) {
            promise.reject("STORAGE_DOWNGRADE_BLOCKED", "STORAGE_DOWNGRADE_BLOCKED")
            return
        }
        try {
            // Validate before entering the foreground: a missing/broken key
            // must not leave an idle foreground service behind.
            if (AgentSettingsStore(react).modelConfig() == null) {
                promise.reject("MODEL_NOT_CONFIGURED", "MODEL_NOT_CONFIGURED")
                return
            }
            if (!BackgroundModeStore(react).enabled()) {
                launchRun(goal, promise)
                return
            }
            // Never pop a permission dialog from send: the task would be
            // rejected anyway. The chat offers an explicit re-authorize
            // action; a grant made there or in the manager is detected by
            // the controller and the next send can use the display.
            //
            // startAndWait polls for up to 5s. Every @ReactMethod here shares the
            // native-modules queue, so waiting inline would stall snapshot polling
            // and approval decisions for the whole wait — exactly while the user is
            // looking at the send they just made.
            startExecutor.execute {
                val status = try {
                    BackgroundDisplayController.get(react).startAndWait(5_000, requestPermission = false)
                } catch (error: Exception) {
                    fail(promise, error)
                    return@execute
                }
                if (!status.optBoolean("connected") ||
                    !status.optBoolean("permissionGranted") ||
                    status.optInt("displayId", -1) <= 0
                ) {
                    val reason = status.optString("error").ifBlank { "后台模式已开启，但后台屏未就绪" }
                    android.util.Log.w("DshAgentModule", "startCloud rejected BACKGROUND_NOT_READY: $reason")
                    promise.reject("BACKGROUND_NOT_READY", reason)
                    return@execute
                }
                try {
                    launchRun(goal, promise)
                } catch (error: Exception) {
                    fail(promise, error)
                }
            }
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    private fun launchRun(goal: String, promise: Promise) {
        val intent = Intent(react, AgentService::class.java).setAction(AgentService.ACTION_RUN)
        if (Build.VERSION.SDK_INT >= 26) react.startForegroundService(intent) else react.startService(intent)
        promise.resolve(AgentRuntime.get(react).startCloud(goal).toString())
    }

    @ReactMethod
    fun decide(callId: String, digest: String, allow: Boolean, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            val result = AgentRuntime.get(react).decide(callId, digest, allow)
            if (!result.optBoolean("ok", true)) {
                val code = result.optString("code", "DECIDE_FAILED")
                promise.reject(code, code)
            } else {
                promise.resolve(result.toString())
            }
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun storageStatus(promise: Promise) {
        if (!supported()) {
            promise.resolve(
                JSONObject()
                    .put("schemaVersion", 2)
                    .put("fromVersion", 2)
                    .put("toVersion", 2)
                    .put("status", "up_to_date")
                    .put("downgradeBlocked", false)
                    .put("quarantinedFiles", org.json.JSONArray())
                    .put("warnings", org.json.JSONArray())
                    .toString(),
            )
            return
        }
        try {
            promise.resolve(AgentRuntime.get(react).storageStatus().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun thread(promise: Promise) {
        if (!supported()) { promise.resolve("[]"); return }
        try {
            promise.resolve(AgentRuntime.get(react).thread().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun sessions(promise: Promise) {
        if (!supported()) {
            promise.resolve("{\"activeSessionId\":\"default\",\"sessions\":[]}")
            return
        }
        try {
            promise.resolve(AgentRuntime.get(react).sessions().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun createSession(title: String?, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).createSession(title).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun switchSession(sessionId: String, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).switchSession(sessionId).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun renameSession(sessionId: String, title: String, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).renameSession(sessionId, title).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun deleteSession(sessionId: String, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).deleteSession(sessionId).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun clearThread(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).clearThread().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun history(promise: Promise) {
        if (!supported()) { promise.resolve("[]"); return }
        try {
            promise.resolve(AgentRuntime.get(react).history().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun acknowledgeRun(runId: String, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).acknowledgeRun(runId).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun getMemory(promise: Promise) {
        try {
            promise.resolve(AgentRuntime.get(react).getMemory().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun getMemoryBudget(promise: Promise) {
        try {
            promise.resolve(AgentRuntime.get(react).getMemoryBudget().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun saveMemory(id: String?, key: String, value: String, promise: Promise) {
        try {
            promise.resolve(AgentRuntime.get(react).saveMemory(id, key, value).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun saveMemoryEntry(
        id: String?,
        key: String,
        value: String,
        kind: String,
        pinned: Boolean,
        enabled: Boolean,
        promise: Promise,
    ) {
        try {
            promise.resolve(AgentRuntime.get(react).saveMemoryEntry(id, key, value, kind, pinned, enabled).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun deleteMemory(id: String, promise: Promise) {
        try {
            promise.resolve(AgentRuntime.get(react).deleteMemory(id))
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun dismissRecovery(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).dismissRecovery().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).pause().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun resume(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).resume().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).stop().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun resumeHandoff(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentRuntime.get(react).resumeHandoff().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundStatus(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).status().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundStart(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).start().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundLaunch(packageName: String, promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).launch(packageName).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundRetry(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).retryNow().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundStop(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).stop().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundArm(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).armAutoStart().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundOpenShizuku(promise: Promise) {
        try {
            val intent = react.packageManager
                .getLaunchIntentForPackage("moe.shizuku.privileged.api")
            if (intent == null) {
                promise.resolve(JSONObject().put("opened", false).put("installed", false).toString())
                return
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            react.startActivity(intent)
            promise.resolve(JSONObject().put("opened", true).put("installed", true).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun backgroundFrame(promise: Promise) {
        try {
            promise.resolve(BackgroundDisplayController.get(react).frameBase64())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun getBackgroundAutoStart(promise: Promise) {
        try {
            promise.resolve(JSONObject().put("enabled", BackgroundModeStore(react).enabled()).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun setBackgroundAutoStart(enabled: Boolean, promise: Promise) {
        try {
            BackgroundModeStore(react).setEnabled(enabled)
            if (!enabled) {
                // Stop waiting for a grant when the user turns auto-start off;
                // an already running display is intentionally left alone.
                BackgroundDisplayController.get(react).disarmAutoStart()
            }
            promise.resolve(JSONObject().put("enabled", enabled).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun getPhoneCapabilities(promise: Promise) {
        try {
            val supported = Build.VERSION.SDK_INT >= 31
            val keyguard = react.getSystemService(KeyguardManager::class.java)
            val result = JSONObject()
                .put("supported", supported)
                .put("accessibilityEnabled", supported && PhoneBridge.isEnabled(react))
                .put("accessibilityConnected", supported && PhoneBridge.isConnected())
                .put("overlayAllowed", PhoneBridge.canDrawOverlays(react))
                .put("screenLocked", keyguard?.isKeyguardLocked == true)
            promise.resolve(result.toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        try {
            react.startActivity(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            promise.resolve(true)
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun openOverlaySettings(promise: Promise) {
        try {
            react.startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${react.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            promise.resolve(true)
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun getModelSettings(promise: Promise) {
        if (!supported()) { promise.resolve(unsupported().toString()); return }
        try {
            promise.resolve(AgentSettingsStore(react).read().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun saveModelSettings(protocol: String, baseUrl: String, model: String, apiKey: String?, promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentSettingsStore(react).save(protocol, baseUrl, model, apiKey).toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun clearModelSettings(promise: Promise) {
        if (!supported()) { promise.reject("AGENT_UNSUPPORTED", "AGENT_UNSUPPORTED"); return }
        try {
            promise.resolve(AgentSettingsStore(react).clear().toString())
        } catch (error: Exception) {
            fail(promise, error)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        if (eventName != STREAM_EVENT_NAME || !supported()) return
        if (streamListeners.incrementAndGet() == 1) {
            AgentRuntime.get(react).setStreamListener { update -> onRuntimeStream(update) }
        }
    }

    @ReactMethod
    fun removeListeners(count: Double) {
        val remove = count.toInt().coerceAtLeast(1)
        val remaining = streamListeners.updateAndGet { current -> (current - remove).coerceAtLeast(0) }
        if (remaining == 0) detachStreamListener()
    }

    override fun invalidate() {
        detachStreamListener()
        // Interrupts an in-flight startAndWait, which treats interruption as "stop
        // waiting" and returns rather than blocking on a module being torn down.
        runCatching { startExecutor.shutdownNow() }
        runCatching { BackgroundDisplayController.close(react) }
        super.invalidate()
    }

    private fun onRuntimeStream(update: AgentRuntime.StreamUpdate) {
        if (streamListeners.get() <= 0) return
        if (update.immediate) {
            synchronized(streamLock) {
                pendingStreamUpdate = null
                lastStreamEmitAt = System.currentTimeMillis()
            }
            streamMain.removeCallbacks(flushStream)
            emitStreamNow(update)
            return
        }
        val delayMs: Long
        synchronized(streamLock) {
            pendingStreamUpdate = update
            val elapsed = System.currentTimeMillis() - lastStreamEmitAt
            delayMs = if (elapsed >= STREAM_THROTTLE_MS) 0L else STREAM_THROTTLE_MS - elapsed
        }
        streamMain.removeCallbacks(flushStream)
        if (delayMs == 0L) {
            streamMain.post(flushStream)
        } else {
            streamMain.postDelayed(flushStream, delayMs)
        }
    }

    private fun emitStreamNow(update: AgentRuntime.StreamUpdate) {
        if (streamListeners.get() <= 0 || !react.hasActiveReactInstance()) return
        val payload = JSONObject()
            .put("runId", update.runId ?: JSONObject.NULL)
            .put("phase", update.phase)
            .put("step", update.step)
            .put("streamText", update.streamText ?: JSONObject.NULL)
            .toString()
        runCatching {
            react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(STREAM_EVENT_NAME, payload)
        }
    }

    private fun detachStreamListener() {
        streamListeners.set(0)
        synchronized(streamLock) { pendingStreamUpdate = null }
        streamMain.removeCallbacks(flushStream)
        if (supported()) runCatching { AgentRuntime.get(react).setStreamListener(null) }
    }

    private fun supported() = Build.VERSION.SDK_INT >= 26

    private fun unsupported(): JSONObject = JSONObject().put("supported", false).put("ok", false).put("phase", "idle")

    private fun fail(promise: Promise, error: Throwable) {
        val message = error.message?.take(500) ?: error.javaClass.simpleName
        val code = message.takeIf { it.matches(Regex("[A-Z_]{1,80}")) } ?: "AGENT_ERROR"
        promise.reject(code, message)
    }
}

class AgentPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(AgentModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
