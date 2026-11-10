package com.dshpocket.agent

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.view.Display
import org.json.JSONArray
import org.json.JSONObject

data class PhoneApp(
    val label: String,
    val packageName: String,
)

/**
 * Thin synchronization layer between the pure tool code and the accessibility
 * service. All operations return a model-readable string; exceptions are turned
 * into explicit error strings so the agent loop cannot mistake a failure for a
 * successful phone action.
 */
object PhoneBridge {
    @Volatile
    private var activeDisplayId: Int = Display.DEFAULT_DISPLAY

    @Volatile
    private var backgroundLauncher: ((String) -> String)? = null

    @Volatile
    private var backgroundKeyHandler: ((String) -> String)? = null

    @Volatile
    private var backgroundTextHandler: ((String) -> String)? = null

    @Volatile
    private var runActive = false

    @Volatile
    private var runBackground = false

    /**
     * Bind one Agent Run to the display it is expected to use. A queued task
     * keeps the expectation captured when it was enqueued, so a display lost
     * between tasks pauses the Run instead of silently running on the main
     * screen.
     */
    fun beginRun(backgroundExpected: Boolean = hasBackgroundDisplay()) {
        runActive = true
        runBackground = backgroundExpected
    }

    fun hasBackgroundDisplay(): Boolean = activeDisplayId != Display.DEFAULT_DISPLAY

    fun endRun() {
        runActive = false
        runBackground = false
    }

    fun runUsesBackground(): Boolean = runActive && runBackground

    fun runDisplayId(): Int = if (runUsesBackground()) activeDisplayId else Display.DEFAULT_DISPLAY

    fun runBackgroundLost(): Boolean = runUsesBackground() && activeDisplayId == Display.DEFAULT_DISPLAY

    fun currentDisplayId(): Int =
        if (runActive) {
            if (runBackground) {
                // Fail closed if the display vanished between the tool's
                // snapshot guard and its action. -1 cannot resolve to a window
                // or key target, so tap/type/scroll/key never fall back to the
                // main display mid-run.
                if (activeDisplayId == Display.DEFAULT_DISPLAY) -1 else activeDisplayId
            } else {
                Display.DEFAULT_DISPLAY
            }
        } else {
            activeDisplayId
        }

    fun isBackground(): Boolean =
        runUsesBackground() || currentDisplayId() != Display.DEFAULT_DISPLAY

    fun setBackgroundDisplay(
        displayId: Int,
        launcher: (String) -> String,
        keyHandler: (String) -> String,
        textHandler: (String) -> String,
    ) {
        activeDisplayId = displayId
        backgroundLauncher = launcher
        backgroundKeyHandler = keyHandler
        backgroundTextHandler = textHandler
    }

    fun clearBackgroundDisplay() {
        activeDisplayId = Display.DEFAULT_DISPLAY
        backgroundLauncher = null
        backgroundKeyHandler = null
        backgroundTextHandler = null
    }

    fun backgroundKey(key: String): String =
        backgroundKeyHandler?.invoke(key) ?: "BACKGROUND_KEY_UNAVAILABLE"

    fun backgroundText(text: String): String =
        backgroundTextHandler?.invoke(text) ?: "BACKGROUND_TEXT_UNAVAILABLE"

    private val SENSITIVE_PACKAGES = listOf(
        "com.android.settings",
        "com.google.android.settings",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.android.vending",
    )

    fun isSensitivePackage(packageName: String?): Boolean =
        packageName != null && SENSITIVE_PACKAGES.any {
            packageName == it || packageName.startsWith("$it.")
        }

    fun isConnected(): Boolean = OutpostAccessibilityService.instance != null

    fun isEnabled(context: Context): Boolean = OutpostAccessibilityService.isEnabled(context)

    /**
     * Some emulator/ROM combinations report Settings.canDrawOverlays=false
     * even though the appop is explicitly allowed. Use the app-op as the
     * fallback so the overlay controller and the settings UI agree.
     */
    fun canDrawOverlays(context: Context): Boolean {
        if (Settings.canDrawOverlays(context)) return true
        return try {
            val appOps = context.getSystemService(AppOpsManager::class.java) ?: return false
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW,
                Process.myUid(),
                context.packageName,
            ) == AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) {
            false
        }
    }

    fun snapshot(): PhoneSnapshot {
        val displayId = currentDisplayId()
        Log.i("DshPhoneBridge", "snapshot display=$displayId background=${isBackground()} connected=${isConnected()}")
        if (runActive && runBackground && activeDisplayId == Display.DEFAULT_DISPLAY) {
            return PhoneSnapshot(
                screenId = 0,
                packageName = null,
                elements = emptyList(),
                sensitive = false,
                sensitiveReason = null,
                locked = false,
                truncated = false,
                error = "BACKGROUND_DISPLAY_LOST",
            )
        }
        val service = OutpostAccessibilityService.instance
            ?: return PhoneSnapshot(
                screenId = 0,
                packageName = null,
                elements = emptyList(),
                sensitive = false,
                sensitiveReason = null,
                locked = false,
                truncated = false,
                error = "ACCESSIBILITY_NOT_CONNECTED",
            )
        return try {
            service.snapshot(displayId)
        } catch (error: Exception) {
            PhoneSnapshot(0, null, emptyList(), false, null, false, false, "ACCESSIBILITY_ERROR: ${error.message}")
        }
    }

    /**
     * Windows go through a short no-active-window state after app launches.
     * Retry a few times rather than turning that transition into a model-visible
     * failure or (worse) a wrong package.
     */
    /**
     * phone_open must not return the previous screen just because the launch
     * command succeeded. Wait briefly for the requested package to become the
     * active window; callers can turn a timeout into a model-visible error.
     */
    fun waitForPackage(packageName: String, attempts: Int = 20, delayMs: Long = 250): PhoneSnapshot {
        var last = snapshot()
        repeat(attempts.coerceAtLeast(0)) {
            if (last.error == null && last.packageName == packageName) return last
            try {
                Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return last
            }
            last = snapshot()
        }
        return last
    }

    fun stableSnapshot(attempts: Int = 6, delayMs: Long = 350): PhoneSnapshot {
        var last = snapshot()
        repeat((attempts - 1).coerceAtLeast(0)) {
            if (last.locked || (last.error == null && last.packageName != null)) return last
            try {
                Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return last
            }
            last = snapshot()
        }
        return last
    }

    fun screenJson(snapshot: PhoneSnapshot): String {
        val root = JSONObject()
            .put("screenId", snapshot.screenId)
            .put("displayId", snapshot.displayId)
            .put("package", snapshot.packageName ?: JSONObject.NULL)
            .put("sensitive", snapshot.sensitive)
            .put("reason", snapshot.sensitiveReason ?: JSONObject.NULL)
            .put("locked", snapshot.locked)
            .put("truncated", snapshot.truncated)
            .put("error", snapshot.error ?: JSONObject.NULL)
        if (!snapshot.sensitive && snapshot.error == null) {
            val elements = JSONArray()
            for (element in snapshot.elements) {
                elements.put(
                    JSONObject()
                        .put("id", element.id)
                        .put("text", element.text)
                        .put("description", element.description)
                        .put("class", element.className)
                        .put("clickable", element.clickable)
                        .put("editable", element.editable)
                        .put("scrollable", element.scrollable)
                        .put("enabled", element.enabled)
                        .put("password", element.isPassword)
                        .put(
                            "bounds",
                            JSONArray(
                                listOf(
                                    element.bounds.left,
                                    element.bounds.top,
                                    element.bounds.right,
                                    element.bounds.bottom,
                                ),
                            ),
                        ),
                )
            }
            root.put("elements", elements)
        }
        return root.toString()
    }

    fun launchableApps(context: Context): List<PhoneApp> {
        val manager = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = try {
            manager.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        } catch (_: Exception) {
            emptyList()
        }
        return resolved.asSequence()
            .mapNotNull { info ->
                val pkg = info.activityInfo?.packageName ?: return@mapNotNull null
                if (pkg == context.packageName) return@mapNotNull null
                val label = try {
                    info.loadLabel(manager).toString()
                } catch (_: Exception) {
                    pkg
                }
                PhoneApp(label.take(80), pkg)
            }
            .distinctBy { it.packageName }
            .sortedBy { it.label.lowercase() }
            .take(100)
            .toList()
    }

    fun openApp(context: Context, packageName: String): String {
        if (packageName.isBlank()) return "INVALID_PACKAGE"
        if (packageName == context.packageName) return "OWN_APP_NOT_ALLOWED"
        if (isBackground()) {
            return backgroundLauncher?.invoke(packageName)
                ?: "BACKGROUND_DISPLAY_UNAVAILABLE"
        }
        val intent = try {
            context.packageManager.getLaunchIntentForPackage(packageName)
        } catch (_: Exception) {
            null
        } ?: return "APP_NOT_LAUNCHABLE"
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            "OK"
        } catch (error: Exception) {
            "OPEN_FAILED: ${error.message}"
        }
    }

    fun appListText(apps: List<PhoneApp>): String =
        apps.joinToString("\n") { "${it.label}\t${it.packageName}" }
}
