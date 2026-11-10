package com.dshpocket.agent.background

import android.app.Application
import android.app.Instrumentation
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.os.Process
import android.os.RemoteException
import android.util.Log
import android.view.Surface
import java.lang.reflect.Constructor
import java.lang.reflect.Field

/**
 * Runs inside Shizuku's UserService process with shell identity.
 *
 * The app process owns the ImageReader surface and the accessibility service;
 * this service only creates/releases the virtual display and launches a
 * component onto it. It never exposes arbitrary shell execution to the model.
 */
class BackgroundDisplayUserService : IBackgroundDisplayService.Stub {
    private var context: Context? = null
    private val displays = HashMap<Int, VirtualDisplay>()

    constructor() : super()

    constructor(context: Context) : super() {
        this.context = context
        Log.i(TAG, "created with Context: $context")
    }

    override fun createDisplay(surface: Surface, width: Int, height: Int, dpi: Int): Int {
        try {
            val ctx = shellContext(context)
            // Do not use ctx.getSystemService(): that returns a DisplayManager
            // bound to the app package, and DisplayManagerService rejects it with
            // "packageName must match the calling uid". Construct it with the
            // shell-wrapped context instead.
            val constructor = DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
            constructor.isAccessible = true
            val manager = constructor.newInstance(ctx)
            val flags = displayFlags()
            val display = try {
                manager.createVirtualDisplay("dsh-background", width, height, dpi, surface, flags)
            } catch (denied: SecurityException) {
                Log.w(TAG, "trusted display flags denied, retrying", denied)
                manager.createVirtualDisplay(
                    "dsh-background", width, height, dpi, surface,
                    flags and (FLAG_TRUSTED or FLAG_OWN_DISPLAY_GROUP or FLAG_ALWAYS_UNLOCKED or
                        FLAG_OWN_FOCUS or FLAG_STEAL_TOP_FOCUS_DISABLED).inv(),
                )
            } ?: throw RemoteException("createVirtualDisplay returned null")
            val id = display.display.displayId
            if (id <= 0) {
                display.release()
                throw RemoteException("invalid display id $id")
            }
            synchronized(displays) { displays[id] = display }
            setFullscreenWindowingMode(id)
            Log.i(TAG, "display $id created, flags=$flags, uid=${Process.myUid()}")
            return id
        } catch (error: RemoteException) {
            throw error
        } catch (error: Throwable) {
            Log.e(TAG, "createDisplay failed", error)
            throw RemoteException("createDisplay: $error")
        }
    }

    override fun launchComponent(displayId: Int, component: String) {
        try {
            synchronized(displays) {
                if (!displays.containsKey(displayId)) throw RemoteException("unknown display $displayId")
            }
            if (component.isBlank() || component.contains(' ')) throw RemoteException("invalid component")
            val process = ProcessBuilder(
                "/system/bin/am", "start", "--display", displayId.toString(),
                "-a", "android.intent.action.MAIN",
                "-c", "android.intent.category.LAUNCHER",
                "-n", component,
            ).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val code = process.waitFor()
            Log.i(TAG, "launch display=$displayId component=$component code=$code output=$output")
            if (code != 0) throw RemoteException("am start failed: $output")
        } catch (error: RemoteException) {
            throw error
        } catch (error: Throwable) {
            Log.e(TAG, "launchComponent failed", error)
            throw RemoteException("launchComponent: $error")
        }
    }

    /**
     * Some systems create a new virtual display in freeform mode; the app then
     * shrinks into a small window and accessibility coordinates are scaled.
     * Set fullscreen before launching anything, like Mika does.
     */
    private fun setFullscreenWindowingMode(displayId: Int) {
        runCatching {
            val wm = Class.forName("android.view.WindowManagerGlobal")
                .getMethod("getWindowManagerService").invoke(null)!!
            wm.javaClass.getMethod("setWindowingMode", Int::class.java, Int::class.java)
                .invoke(wm, displayId, 1)
        }.onFailure {
            Log.w(TAG, "setWindowingMode failed, falling back to wm", it)
            runCatching {
                ProcessBuilder("/system/bin/wm", "set-display-windowing-mode", "-d", displayId.toString(), "1")
                    .start().waitFor()
            }
        }
    }

    override fun injectKey(displayId: Int, key: String) {
        try {
            synchronized(displays) {
                if (!displays.containsKey(displayId)) throw RemoteException("unknown display $displayId")
            }
            val code = when (key.lowercase()) {
                "back" -> 4
                "home" -> 3
                "recents" -> 187
                else -> throw RemoteException("invalid key $key")
            }
            val process = ProcessBuilder(
                "/system/bin/input", "-d", displayId.toString(), "keyevent", code.toString(),
            ).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val exit = process.waitFor()
            if (exit != 0) throw RemoteException("input key failed: $output")
        } catch (error: RemoteException) {
            throw error
        } catch (error: Throwable) {
            Log.e(TAG, "injectKey failed", error)
            throw RemoteException("injectKey: $error")
        }
    }

    override fun injectText(displayId: Int, text: String) {
        try {
            synchronized(displays) {
                if (!displays.containsKey(displayId)) throw RemoteException("unknown display $displayId")
            }
            if (text.isEmpty() || text.length > 2000) {
                throw RemoteException("invalid text length")
            }
            // `input text` only reliably injects printable ASCII; Unicode is
            // handled by accessibility ACTION_SET_TEXT/clipboard first.
            if (text.any { it.code !in 0x20..0x7E }) {
                throw RemoteException("input text supports ASCII only")
            }
            val escaped = text.replace(" ", "%s")
            val process = ProcessBuilder(
                "/system/bin/input", "-d", displayId.toString(), "text", escaped,
            ).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val exit = process.waitFor()
            if (exit != 0) throw RemoteException("input text failed: $output")
        } catch (error: RemoteException) {
            throw error
        } catch (error: Throwable) {
            Log.e(TAG, "injectText failed", error)
            throw RemoteException("injectText: $error")
        }
    }

    override fun releaseDisplay(displayId: Int) {
        val display = synchronized(displays) { displays.remove(displayId) }
        if (display != null) {
            display.release()
            Log.i(TAG, "display $displayId released")
        }
    }

    override fun info(): String {
        val ids = synchronized(displays) { displays.keys.toList() }
        return "pid=${Process.myPid()}, uid=${Process.myUid()}, displays=$ids"
    }

    override fun destroy() {
        val all = synchronized(displays) {
            val copy = displays.values.toList()
            displays.clear()
            copy
        }
        all.forEach { runCatching { it.release() } }
        Log.i(TAG, "destroy")
        System.exit(0)
    }

    private fun displayFlags(): Int {
        var flags = FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH or
            FLAG_ROTATES_WITH_CONTENT or FLAG_DESTROY_CONTENT_ON_REMOVAL or FLAG_TOUCH_FEEDBACK_DISABLED
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            flags = flags or FLAG_TRUSTED or FLAG_OWN_DISPLAY_GROUP or FLAG_ALWAYS_UNLOCKED
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            flags = flags or FLAG_OWN_FOCUS or FLAG_STEAL_TOP_FOCUS_DISABLED
        }
        return flags
    }

    private fun shellContext(provided: Context?): Context {
        val base = provided ?: systemContext()
        return ShellContext(base)
    }

    private fun systemContext(): Context {
        val activityThreadClass = Class.forName("android.app.ActivityThread")
        val thread = activityThreadClass.getMethod("currentActivityThread").invoke(null)
            ?: newActivityThread(activityThreadClass)
        val method = activityThreadClass.getDeclaredMethod("getSystemContext")
        method.isAccessible = true
        return method.invoke(thread) as Context
    }

    private fun newActivityThread(activityThreadClass: Class<*>): Any {
        val constructor: Constructor<*> = activityThreadClass.getDeclaredConstructor()
        constructor.isAccessible = true
        val thread = constructor.newInstance()
        activityThreadClass.getDeclaredField("sCurrentActivityThread").apply {
            isAccessible = true
            set(null, thread)
        }
        activityThreadClass.getDeclaredField("mSystemThread").apply {
            isAccessible = true
            setBoolean(thread, true)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching {
                val controllerClass = Class.forName("android.app.ConfigurationController")
                val internalClass = Class.forName("android.app.ActivityThreadInternal")
                val controllerConstructor = controllerClass.getDeclaredConstructor(internalClass)
                controllerConstructor.isAccessible = true
                activityThreadClass.getDeclaredField("mConfigurationController").apply {
                    isAccessible = true
                    set(thread, controllerConstructor.newInstance(thread))
                }
            }
        }
        runCatching {
            val bindDataClass = Class.forName("android.app.ActivityThread\$AppBindData")
            val bindDataConstructor = bindDataClass.getDeclaredConstructor()
            bindDataConstructor.isAccessible = true
            val bindData = bindDataConstructor.newInstance()
            val info = ApplicationInfo()
            info.packageName = SHELL_PACKAGE
            bindDataClass.getDeclaredField("appInfo").apply {
                isAccessible = true
                set(bindData, info)
            }
            activityThreadClass.getDeclaredField("mBoundApplication").apply {
                isAccessible = true
                set(thread, bindData)
            }
        }
        runCatching {
            val initial = activityThreadClass.getDeclaredField("mInitialApplication")
            initial.isAccessible = true
            if (initial.get(thread) == null) {
                initial.set(thread, Instrumentation.newApplication(Application::class.java, ShellContext(systemContext())))
            }
        }
        return thread
    }

    private class ShellContext(base: Context) : ContextWrapper(base) {
        override fun getPackageName(): String = SHELL_PACKAGE
        override fun getOpPackageName(): String = SHELL_PACKAGE
        override fun getApplicationContext(): Context = this
        override fun getAttributionSource(): AttributionSource =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AttributionSource.Builder(SHELL_UID).setPackageName(SHELL_PACKAGE).build()
            } else {
                super.getAttributionSource()
            }
    }

    private companion object {
        const val TAG = "DshBackgroundDisplay"
        const val SHELL_PACKAGE = "com.android.shell"
        const val SHELL_UID = 2000
        const val FLAG_PUBLIC = 1 shl 0
        const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
        const val FLAG_SUPPORTS_TOUCH = 1 shl 6
        const val FLAG_ROTATES_WITH_CONTENT = 1 shl 7
        const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
        const val FLAG_TRUSTED = 1 shl 10
        const val FLAG_OWN_DISPLAY_GROUP = 1 shl 11
        const val FLAG_ALWAYS_UNLOCKED = 1 shl 12
        const val FLAG_TOUCH_FEEDBACK_DISABLED = 1 shl 13
        const val FLAG_OWN_FOCUS = 1 shl 14
        const val FLAG_STEAL_TOP_FOCUS_DISABLED = 1 shl 16
    }
}
