package com.dshpocket.agent.background

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.Log
import com.dshpocket.BuildConfig
import com.dshpocket.agent.PhoneBridge
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.io.ByteArrayOutputStream

/**
 * App-side owner of the experimental background display.
 *
 * The Surface and all frames stay in this process (ImageReader), while a
 * Shizuku UserService running as shell creates the display and launches the
 * component onto it. The controller is lazy: no Shizuku code runs until the
 * experiment screen asks for status/start.
 */
class BackgroundDisplayController private constructor(
    private val react: ReactApplicationContext,
) {
    companion object {
        private const val REQUEST_PERMISSION = 4401
        private const val PREVIEW_WIDTH = 360
        private const val TAG = "DshBackgroundDisplay"
        private const val MAX_RETRIES = 3
        private const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
        private const val MESSAGE_PERMISSION_REVOKED =
            "Shizuku 权限已被撤销，请在 Shizuku 中重新授权"
        private const val MESSAGE_PERMISSION_REQUIRED = "尚未获得 Shizuku 权限，请先授权"
        private val FAILURE_STATES = setOf(
            "unsupported",
            "shizuku_not_running",
            "permission_required",
            "permission_denied",
            "permission_revoked",
            "error",
            "disconnected",
            "stopped",
            "not_running",
        )

        @Volatile
        private var instance: BackgroundDisplayController? = null

        fun get(react: ReactApplicationContext): BackgroundDisplayController =
            instance ?: synchronized(this) {
                instance ?: BackgroundDisplayController(react).also { instance = it }
            }

        fun close(react: ReactApplicationContext) {
            synchronized(this) {
                instance?.shutdown()
                instance = null
            }
        }

        /** Called by AgentRuntime after the queue drains; no-op if nothing is running. */
        fun stopIfRunning(): JSONObject? = instance?.stop()

        /** Used by the overlay approval card to recover a lost display. */
        fun retryIfExists(): JSONObject? = instance?.retryNow()
    }

    private val lock = Any()
    private val frameThread = HandlerThread("dsh-background-frames").apply { start() }
    private val frameHandler = Handler(frameThread.looper)
    private val mainHandler = Handler(android.os.Looper.getMainLooper())
    private var retryAttempts = 0
    private var retryRunnable: Runnable? = null
    private var permissionWatchRunnable: Runnable? = null
    private var bindTimeoutRunnable: Runnable? = null
    private var everConnected = BackgroundModeStore(react).everAuthorized()

    private var service: IBackgroundDisplayService? = null
    private var reader: ImageReader? = null
    private var displayId = -1
    private var latestFrame: Bitmap? = null
    private var state = "idle"
    private var error: String? = null
    private var startRequested = false
    private var stopping = false

    private val serviceArgs = Shizuku.UserServiceArgs(
        ComponentName(react.packageName, BackgroundDisplayUserService::class.java.name),
    )
        .daemon(false)
        .processNameSuffix("background")
        .debuggable(BuildConfig.DEBUG)
        .version(1)

    private val binderReceived = Shizuku.OnBinderReceivedListener {
        synchronized(lock) {
            if (state == "idle" || state == "shizuku_stopped") state = "shizuku_ready"
        }
        if (startRequested) {
            maybeBind()
            ensurePermissionWatch()
        }
    }

    private val binderDead = Shizuku.OnBinderDeadListener {
        cancelPermissionWatch()
        cancelBindTimeout()
        synchronized(lock) {
            service = null
            state = "shizuku_stopped"
            error = "Shizuku 已停止；启动后会自动恢复"
            closeReaderLocked()
            displayId = -1
        }
        PhoneBridge.clearBackgroundDisplay()
        scheduleRetry("Shizuku 已停止")
    }

    private val permissionResult = Shizuku.OnRequestPermissionResultListener { _, grantResult ->
        if (grantResult == PackageManager.PERMISSION_GRANTED) {
            synchronized(lock) { error = null }
            retryAttempts = 0
            cancelRetry()
            if (startRequested) maybeBind()
            ensurePermissionWatch()
        } else {
            retryAttempts = 0
            cancelRetry()
            synchronized(lock) {
                state = "permission_denied"
                error = "未获得 Shizuku 权限；可稍后重新授权"
            }
            ensurePermissionWatch()
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            cancelBindTimeout()
            if (!binder.pingBinder()) {
                fail("UserService binder 无效", IllegalStateException("invalid binder"))
                return
            }
            val usable = synchronized(lock) { startRequested && !stopping }
            if (!usable) return
            if (!hasPermission()) {
                // A late bind callback after a revocation must not create a
                // display (the UserService itself runs as shell and would
                // happily do it).
                cancelRetry()
                synchronized(lock) { settlePermissionStateLocked() }
                PhoneBridge.clearBackgroundDisplay()
                runCatching { Shizuku.unbindUserService(serviceArgs, this, true) }
                ensurePermissionWatch()
                return
            }
            val remote = IBackgroundDisplayService.Stub.asInterface(binder)
            synchronized(lock) { service = remote; stopping = false }
            runCatching { createDisplay(remote) }
                .onFailure { fail("后台屏创建失败", it) }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            cancelBindTimeout()
            val wasStopping = stopping
            val permissionLost = !wasStopping && binderAlive() && !hasPermission()
            synchronized(lock) {
                service = null
                displayId = -1
                closeReaderLocked()
                state = when {
                    wasStopping -> "stopped"
                    permissionLost -> "permission_revoked"
                    else -> "disconnected"
                }
                error = when {
                    wasStopping -> null
                    permissionLost -> MESSAGE_PERMISSION_REVOKED
                    else -> "Shizuku UserService 已断开"
                }
                stopping = false
            }
            PhoneBridge.clearBackgroundDisplay()
            if (wasStopping) return
            if (permissionLost) {
                cancelRetry()
                ensurePermissionWatch()
            } else {
                scheduleRetry("Shizuku UserService 已断开")
            }
        }
    }

    init {
        runCatching {
            Shizuku.addBinderReceivedListenerSticky(binderReceived)
            Shizuku.addBinderDeadListener(binderDead)
            Shizuku.addRequestPermissionResultListener(permissionResult)
        }.onFailure {
            synchronized(lock) {
                state = "error"
                error = "Shizuku API 初始化失败：${it.message}"
            }
        }
    }

    fun status(): JSONObject = synchronized(lock) {
        val binder = runCatching { Shizuku.getBinder() }.getOrNull()
        val permission = runCatching {
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
        }.getOrDefault(false)
        JSONObject()
            .put("supported", Build.VERSION.SDK_INT >= 31)
            .put("installed", isShizukuInstalled())
            .put("shizukuRunning", binder != null)
            .put("permissionGranted", permission)
            .put("connected", service != null)
            .put("displayId", displayId)
            .put("frameAvailable", latestFrame != null)
            .put("state", state)
            .put("error", error ?: JSONObject.NULL)
    }

    fun start(requestPermission: Boolean = true): JSONObject {
        retryAttempts = 0
        cancelRetry()
        if (Build.VERSION.SDK_INT < 31) {
            synchronized(lock) { state = "unsupported"; error = "需要 Android 12 及以上" }
            return status()
        }
        synchronized(lock) { startRequested = true; stopping = false; error = null }
        val binder = runCatching { Shizuku.getBinder() }.getOrNull()
        if (binder == null) {
            synchronized(lock) {
                state = "shizuku_not_running"
                error = if (isShizukuInstalled()) {
                    "Shizuku 未运行；启动后会自动恢复"
                } else {
                    "未安装 Shizuku；请先安装并启动 Shizuku"
                }
            }
            return status()
        }
        if (!hasPermission()) {
            // A revoked permission cannot be retried away. Request a new grant
            // only from an explicit user action; a send must not pop a dialog
            // whose task will be rejected anyway.
            if (requestPermission) {
                runCatching { Shizuku.requestPermission(REQUEST_PERMISSION) }
                    .onFailure { fail("请求 Shizuku 权限失败", it) }
            }
            synchronized(lock) { settlePermissionStateLocked() }
            ensurePermissionWatch()
            return status()
        }
        maybeBind()
        return status()
    }

    /**
     * Used by the chat when auto-start is enabled: wait for Shizuku without
     * popping a permission dialog. If the user grants the permission in the
     * Shizuku manager (or through the visible re-authorize button), the
     * permission watcher creates the display without another tap.
     */
    fun armAutoStart(): JSONObject {
        if (!BackgroundModeStore(react).enabled()) return status()
        synchronized(lock) {
            startRequested = true
            stopping = false
        }
        when {
            hasPermission() -> maybeBind()
            binderAlive() -> {
                synchronized(lock) {
                    if (state == "idle" || state == "stopped" || state == "shizuku_ready") {
                        settlePermissionStateLocked()
                    }
                }
                ensurePermissionWatch(0)
            }
            else -> {
                // OnBinderReceived will bind (and re-check the permission) once
                // the user starts Shizuku; no polling while the server is gone.
                synchronized(lock) {
                    if (state == "idle" || state == "shizuku_ready") {
                        state = "shizuku_not_running"
                        error = if (isShizukuInstalled()) {
                            "Shizuku 未运行；启动后会自动恢复"
                        } else {
                            "未安装 Shizuku；请先安装并启动 Shizuku"
                        }
                    }
                }
            }
        }
        return status()
    }

    /**
     * Used by startCloud when auto-start is enabled: bind/create the display
     * and wait briefly so the Run really starts on the background screen.
     * It does not request a new permission; permission states are returned
     * immediately so the caller can reject instead of degrading to the main
     * display.
     */
    fun startAndWait(timeoutMs: Long = 5_000, requestPermission: Boolean = true): JSONObject {
        val first = start(requestPermission)
        val state0 = first.optString("state")
        if ((first.optBoolean("connected") && first.optBoolean("permissionGranted")) ||
            state0 in FAILURE_STATES
        ) {
            return first
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(100)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
            val next = status()
            if (next.optBoolean("connected") &&
                next.optBoolean("permissionGranted") &&
                next.optInt("displayId", -1) > 0
            ) {
                return next
            }
            if (next.optString("state") in FAILURE_STATES) return next
        }
        return status()
    }

    fun retryNow(): JSONObject {
        retryAttempts = 0
        cancelRetry()
        synchronized(lock) {
            error = null
            startRequested = true
            stopping = false
        }
        return start()
    }

    /**
     * Turning auto-start off must also stop waiting for a grant: otherwise a
     * later grant in the Shizuku manager would silently create a display the
     * user no longer asked for. A display that is already running is kept.
     */
    fun disarmAutoStart(): JSONObject {
        if (BackgroundModeStore(react).enabled()) return status()
        val idle = synchronized(lock) { service == null && displayId <= 0 }
        if (idle) {
            cancelRetry()
            cancelPermissionWatch()
            synchronized(lock) {
                startRequested = false
                if (state in setOf(
                        "permission_required",
                        "permission_denied",
                        "permission_revoked",
                        "retrying",
                    )
                ) {
                    state = "stopped"
                    error = null
                }
            }
        }
        return status()
    }

    private fun scheduleRetry(reason: String) {
        if (!startRequested || stopping) return
        // Revoking the Shizuku permission is not a transient binder failure:
        // retrying cannot succeed and must not turn into a retry_exhausted
        // banner. Stop the retry loop and wait for a new grant instead.
        if (binderAlive() && !hasPermission()) {
            cancelRetry()
            synchronized(lock) { settlePermissionStateLocked() }
            ensurePermissionWatch()
            return
        }
        synchronized(lock) {
            if (retryRunnable != null) return
            if (retryAttempts >= MAX_RETRIES) {
                state = "retry_exhausted"
                error = "$reason（已重试 $MAX_RETRIES 次）"
                return
            }
            val delayMs = (1_000L shl retryAttempts).coerceAtMost(8_000L)
            retryAttempts += 1
            state = "retrying"
            error = reason
            val runnable = object : Runnable {
                override fun run() {
                    synchronized(lock) {
                        if (retryRunnable === this) retryRunnable = null
                    }
                    if (startRequested && !stopping) maybeBind()
                }
            }
            retryRunnable = runnable
            mainHandler.postDelayed(runnable, delayMs)
        }
    }

    private fun cancelRetry() {
        val runnable = synchronized(lock) {
            val current = retryRunnable
            retryRunnable = null
            current
        }
        if (runnable != null) mainHandler.removeCallbacks(runnable)
    }

    private fun binderAlive(): Boolean = runCatching { Shizuku.getBinder() != null }.getOrDefault(false)

    private fun hasPermission(): Boolean = runCatching {
        Shizuku.getBinder() != null &&
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    private fun isShizukuInstalled(): Boolean = try {
        react.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
        true
    } catch (_: Throwable) {
        false
    }

    /**
     * Poll while an explicit start or auto-start is waiting for a grant. This
     * covers a re-grant made outside the app (the Shizuku manager row) while
     * the chat shows the recovery banner. Shizuku reports the permission from
     * a process-wide cached value and force-stops the client when the manager
     * revokes it, so a running display is not polled: in-process revocation is
     * detected by bind/create failures or UserService disconnect instead.
     */
    private fun ensurePermissionWatch(delayMs: Long = 3_000) {
        if (!startRequested || stopping) return
        synchronized(lock) {
            if (permissionWatchRunnable != null) return
            val runnable = object : Runnable {
                override fun run() {
                    synchronized(lock) {
                        if (permissionWatchRunnable === this) permissionWatchRunnable = null
                    }
                    checkPermission()
                }
            }
            permissionWatchRunnable = runnable
            mainHandler.postDelayed(runnable, delayMs)
        }
    }

    private fun cancelPermissionWatch() {
        val runnable = synchronized(lock) {
            val current = permissionWatchRunnable
            permissionWatchRunnable = null
            current
        }
        if (runnable != null) mainHandler.removeCallbacks(runnable)
    }

    private fun checkPermission() {
        if (!startRequested || stopping) {
            cancelPermissionWatch()
            return
        }
        if (!binderAlive()) {
            // The server is gone; OnBinderReceived will resume the bind.
            synchronized(lock) {
                if (state != "stopped") {
                    state = "shizuku_not_running"
                    error = "Shizuku 未运行；启动后会自动恢复"
                }
            }
            return
        }
        if (!hasPermission()) {
            val active = synchronized(lock) { service != null || displayId > 0 }
            if (active) {
                markPermissionRevoked()
            } else {
                cancelRetry()
                synchronized(lock) {
                    if (state != "permission_denied") settlePermissionStateLocked()
                }
                ensurePermissionWatch()
            }
            return
        }
        val shouldBind = synchronized(lock) { service == null }
        if (shouldBind) {
            retryAttempts = 0
            cancelRetry()
            synchronized(lock) { error = null }
            maybeBind()
        }
    }

    private fun markPermissionRevoked() {
        synchronized(lock) { if (stopping || !startRequested) return }
        cancelBindTimeout()
        val remote: IBackgroundDisplayService?
        val id: Int
        synchronized(lock) {
            remote = service
            id = displayId
        }
        runCatching { if (remote != null && id > 0) remote.releaseDisplay(id) }
        cancelRetry()
        synchronized(lock) {
            service = null
            displayId = -1
            closeReaderLocked()
            state = "permission_revoked"
            error = MESSAGE_PERMISSION_REVOKED
            retryAttempts = 0
        }
        PhoneBridge.clearBackgroundDisplay()
        runCatching { Shizuku.unbindUserService(serviceArgs, connection, true) }
        ensurePermissionWatch()
    }

    private fun maybeBind() {
        val granted = runCatching {
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
        }.getOrDefault(false)
        if (!granted) {
            cancelRetry()
            synchronized(lock) { settlePermissionStateLocked() }
            ensurePermissionWatch()
            return
        }
        val current = synchronized(lock) { service }
        if (current != null) {
            if (synchronized(lock) { displayId } <= 0) {
                runCatching { createDisplay(current) }.onFailure { fail("后台屏创建失败", it) }
            }
            return
        }
        val alreadyBinding = synchronized(lock) {
            if (state == "binding") true else { state = "binding"; false }
        }
        if (alreadyBinding) return
        startBindTimeout()
        runCatching { Shizuku.bindUserService(serviceArgs, connection) }
            .onFailure { fail("绑定 Shizuku UserService 失败", it) }
    }

    private fun startBindTimeout() {
        cancelBindTimeout()
        val runnable = object : Runnable {
            override fun run() {
                val timedOut = synchronized(lock) {
                    if (bindTimeoutRunnable === this) bindTimeoutRunnable = null
                    if (state == "binding" && startRequested && !stopping) {
                        state = "error"
                        error = "绑定 Shizuku UserService 超时"
                        true
                    } else {
                        false
                    }
                }
                if (timedOut) scheduleRetry("绑定 Shizuku UserService 超时")
            }
        }
        synchronized(lock) { bindTimeoutRunnable = runnable }
        mainHandler.postDelayed(runnable, 10_000)
    }

    private fun cancelBindTimeout() {
        val runnable = synchronized(lock) {
            val current = bindTimeoutRunnable
            bindTimeoutRunnable = null
            current
        }
        if (runnable != null) mainHandler.removeCallbacks(runnable)
    }

    private fun settlePermissionStateLocked() {
        state = if (everConnected) "permission_revoked" else "permission_required"
        error = if (everConnected) MESSAGE_PERMISSION_REVOKED else MESSAGE_PERMISSION_REQUIRED
        retryAttempts = 0
    }

    private fun createDisplay(remote: IBackgroundDisplayService) {
        val metrics = react.resources.displayMetrics
        val width = metrics.widthPixels.coerceAtLeast(1)
        val height = metrics.heightPixels.coerceAtLeast(1)
        val dpi = metrics.densityDpi
        val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader.setOnImageAvailableListener({ source -> onFrame(source) }, frameHandler)
        synchronized(lock) { reader = imageReader }
        val id = remote.createDisplay(imageReader.surface, width, height, dpi)
        if (id <= 0) {
            imageReader.close()
            synchronized(lock) { reader = null }
            throw IllegalStateException("createDisplay returned $id")
        }
        synchronized(lock) {
            displayId = id
            state = "running"
            error = null
            everConnected = true
        }
        BackgroundModeStore(react).markAuthorized()
        retryAttempts = 0
        cancelRetry()
        cancelPermissionWatch()
        cancelBindTimeout()
        PhoneBridge.setBackgroundDisplay(
            displayId = id,
            launcher = { packageName -> launchForTool(packageName) },
            keyHandler = { key -> injectKeyForTool(key) },
            textHandler = { text -> injectTextForTool(text) },
        )
        // Auto-start must not land on a sensitive system screen. Contacts is a
        // safe visible default; the task can launch its real target via phone_open.
        runCatching { launchInternal(remote, id, "com.android.contacts") }
            .onFailure { Log.w(TAG, "default launch failed", it) }
    }

    fun launch(packageName: String): JSONObject {
        val remote: IBackgroundDisplayService?
        val id: Int
        synchronized(lock) {
            remote = service
            id = displayId
        }
        if (remote == null || id <= 0) {
            synchronized(lock) {
                state = "not_running"
                error = "后台屏尚未启动"
            }
            return status()
        }
        runCatching { launchInternal(remote, id, packageName) }
            .onFailure { fail("启动 $packageName 失败", it) }
        return status()
    }

    private fun launchInternal(remote: IBackgroundDisplayService, id: Int, packageName: String) {
        val candidates = when (packageName) {
            "com.android.contacts", "com.google.android.contacts" ->
                listOf(packageName, "com.android.contacts", "com.google.android.contacts").distinct()
            else -> listOf(packageName)
        }
        var lastError: Throwable? = null
        for (candidate in candidates) {
            val intent = react.packageManager.getLaunchIntentForPackage(candidate) ?: continue
            val component = intent.component ?: continue
            try {
                remote.launchComponent(id, component.flattenToString())
                synchronized(lock) { state = "running"; error = null }
                return
            } catch (error: Throwable) {
                lastError = error
            }
        }
        throw IllegalStateException(lastError?.message ?: "没有找到可启动的 $packageName")
    }

    private fun launchForTool(packageName: String): String {
        val status = launch(packageName)
        // org.json optString() turns a JSON null into the literal "null";
        // check isNull so a successful launch is not reported as a failure.
        val message = if (status.isNull("error")) "" else status.optString("error", "")
        return if (message.isBlank()) "OK" else "OPEN_FAILED: $message"
    }

    private fun injectKeyForTool(key: String): String {
        val remote: IBackgroundDisplayService?
        val id: Int
        synchronized(lock) {
            remote = service
            id = displayId
        }
        if (remote == null || id <= 0) return "BACKGROUND_DISPLAY_UNAVAILABLE"
        return try {
            remote.injectKey(id, key)
            "OK"
        } catch (error: Throwable) {
            "KEY_FAILED: ${error.message ?: error.javaClass.simpleName}"
        }
    }

    private fun injectTextForTool(text: String): String {
        val remote: IBackgroundDisplayService?
        val id: Int
        synchronized(lock) {
            remote = service
            id = displayId
        }
        if (remote == null || id <= 0) return "BACKGROUND_DISPLAY_UNAVAILABLE"
        return try {
            remote.injectText(id, text)
            "OK"
        } catch (error: Throwable) {
            "TEXT_FAILED: ${error.message ?: error.javaClass.simpleName}"
        }
    }

    private fun onFrame(source: ImageReader) {
        var image: android.media.Image? = null
        try {
            image = source.acquireLatestImage() ?: return
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val paddedWidth = rowStride / pixelStride
            val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(plane.buffer)
            val full = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            padded.recycle()
            val previewHeight = (PREVIEW_WIDTH.toLong() * full.height / full.width)
                .toInt().coerceAtLeast(1)
            val preview = Bitmap.createScaledBitmap(full, PREVIEW_WIDTH, previewHeight, true)
            full.recycle()
            synchronized(lock) {
                latestFrame?.recycle()
                latestFrame = preview
            }
        } catch (_: Throwable) {
            // A dropped frame is not fatal; the next one will replace it.
        } finally {
            image?.close()
        }
    }

    fun frameBase64(): String? = synchronized(lock) {
        val frame = latestFrame ?: return null
        val out = ByteArrayOutputStream()
        return try {
            frame.compress(Bitmap.CompressFormat.PNG, 80, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            null
        } finally {
            out.close()
        }
    }

    fun stop(): JSONObject {
        cancelRetry()
        cancelPermissionWatch()
        cancelBindTimeout()
        retryAttempts = 0
        synchronized(lock) { startRequested = false; stopping = true }
        val remote = synchronized(lock) { service }
        val id = synchronized(lock) { displayId }
        if (remote != null && id > 0) {
            runCatching { remote.releaseDisplay(id) }
        }
        synchronized(lock) {
            service = null
            displayId = -1
            closeReaderLocked()
            state = "stopped"
            error = null
        }
        PhoneBridge.clearBackgroundDisplay()
        runCatching { Shizuku.unbindUserService(serviceArgs, connection, true) }
        return status()
    }

    private fun closeReaderLocked() {
        reader?.close()
        reader = null
        latestFrame?.recycle()
        latestFrame = null
    }

    private fun fail(prefix: String, error: Throwable) {
        cancelBindTimeout()
        if (isPermissionFailure(error)) {
            markPermissionRevoked()
            return
        }
        synchronized(lock) {
            state = "error"
            this.error = "$prefix：${error.message ?: error.javaClass.simpleName}"
        }
        scheduleRetry(prefix)
    }

    private fun isPermissionFailure(error: Throwable): Boolean {
        var current: Throwable? = error
        while (current != null) {
            val message = current.message ?: ""
            if (message.contains("Permission Denial", ignoreCase = true) ||
                message.contains("permission denied", ignoreCase = true) ||
                (current is SecurityException && message.contains("permission", ignoreCase = true))
            ) {
                return true
            }
            current = current.cause
        }
        return false
    }

    fun shutdown() {
        runCatching { stop() }
        runCatching {
            Shizuku.removeBinderReceivedListener(binderReceived)
            Shizuku.removeBinderDeadListener(binderDead)
            Shizuku.removeRequestPermissionResultListener(permissionResult)
        }
        frameThread.quitSafely()
    }
}
