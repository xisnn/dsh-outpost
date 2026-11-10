package com.dshpocket.agent

import android.content.Context
import android.view.Display
import com.dshpocket.agent.core.AgentTool
import com.dshpocket.agent.core.ToolCall
import com.dshpocket.agent.core.ToolOutput
import com.dshpocket.agent.core.ToolRisk
import com.dshpocket.agent.core.ToolSpec
import com.dshpocket.agent.core.ToolStatus

fun interface HandoffGate {
    /** Blocks until the user resumes or stops; true means resume. */
    fun await(reason: String): Boolean
}

/** P6-2 phone tools. Element ids replace model-supplied coordinates. */
class PhoneTools(
    private val context: Context,
    private val handoff: HandoffGate,
) {
    fun all(): List<AgentTool> = listOf(
        PhoneScreenTool(handoff),
        PhoneAppsTool(context),
        PhoneOpenTool(context, handoff),
        PhoneTapTool(handoff),
        PhoneTypeTool(handoff),
        PhoneScrollTool(handoff),
        PhoneKeyTool(handoff),
        PhoneHandoffTool(handoff),
    )
}

private fun guard(handoff: HandoffGate): ToolOutput? {
    val screen = PhoneBridge.stableSnapshot()
    if (screen.error != null) return ToolOutput(ToolStatus.ERROR, screen.error)
    if (screen.locked) {
        return ToolOutput(ToolStatus.ERROR, "SCREEN_LOCKED: unlock the phone before using phone tools")
    }
    if (screen.sensitive) {
        val reason = screen.sensitiveReason ?: "sensitive screen"
        val resumed = handoff.await("需要你接管手机：$reason")
        return ToolOutput(
            ToolStatus.DENIED,
            "SENSITIVE_SCREEN: $reason; the action was not executed" +
                if (resumed) " (handoff resumed)" else " (handoff stopped)",
        )
    }
    return null
}

private fun screenOutput(prefix: String): ToolOutput {
    val screen = PhoneBridge.stableSnapshot()
    if (screen.error != null) return ToolOutput(ToolStatus.ERROR, "$prefix\n${screen.error}")
    return ToolOutput(ToolStatus.OK, "$prefix\n" + PhoneBridge.screenJson(screen))
}

/**
 * A successful back/home can close the last app on a virtual display. The
 * display stays alive but has no application window, so the post-key snapshot
 * legitimately reports ACCESSIBILITY_NO_ACTIVE_WINDOW. The key was already
 * injected; report it as success with an empty screen instead of turning the
 * key into a model-visible error.
 */
private fun keyOutput(prefix: String, displayId: Int): ToolOutput {
    val screen = PhoneBridge.stableSnapshot(attempts = 3, delayMs = 250)
    if (screen.error == null) return ToolOutput(ToolStatus.OK, "$prefix\n" + PhoneBridge.screenJson(screen))
    if (screen.error == "ACCESSIBILITY_NO_ACTIVE_WINDOW" || screen.error == "ACCESSIBILITY_NOT_CONNECTED") {
        val empty = PhoneSnapshot(
            screenId = 0,
            packageName = null,
            elements = emptyList(),
            sensitive = false,
            sensitiveReason = null,
            locked = false,
            truncated = false,
            error = null,
            displayId = displayId,
        )
        return ToolOutput(ToolStatus.OK, "$prefix\n" + PhoneBridge.screenJson(empty))
    }
    return ToolOutput(ToolStatus.ERROR, "$prefix\n${screen.error}")
}

private fun stringArgument(call: ToolCall, name: String): String? =
    (call.arguments[name] as? String)?.takeIf { it.isNotBlank() }

private class PhoneScreenTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.READ
    override val spec = ToolSpec(
        name = "phone_screen",
        description = "Read the active phone screen element tree. Use only ids returned by this tool for later phone actions.",
        parameters = mapOf("type" to "object", "properties" to emptyMap<String, Any>()),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val screen = PhoneBridge.stableSnapshot()
        if (screen.error != null) return ToolOutput(ToolStatus.ERROR, screen.error)
        if (screen.locked) return ToolOutput(ToolStatus.ERROR, "SCREEN_LOCKED: unlock the phone first")
        if (screen.sensitive) {
            val reason = screen.sensitiveReason ?: "sensitive screen"
            val resumed = handoff.await("需要你接管手机：$reason")
            return ToolOutput(
                ToolStatus.DENIED,
                "SENSITIVE_SCREEN: $reason; screen content is not sent to the model" +
                    if (resumed) " (handoff resumed)" else " (handoff stopped)",
            )
        }
        return ToolOutput(ToolStatus.OK, PhoneBridge.screenJson(screen))
    }
}

private class PhoneAppsTool(private val context: Context) : AgentTool {
    override val risk = ToolRisk.READ
    override val spec = ToolSpec(
        name = "phone_apps",
        description = "List launchable apps (label and package name) that can be opened with phone_open.",
        parameters = mapOf("type" to "object", "properties" to emptyMap<String, Any>()),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val apps = PhoneBridge.launchableApps(context)
        return ToolOutput(ToolStatus.OK, PhoneBridge.appListText(apps).ifBlank { "NO_LAUNCHABLE_APPS" })
    }
}

private class PhoneOpenTool(
    private val context: Context,
    private val handoff: HandoffGate,
) : AgentTool {
    override val risk = ToolRisk.PHONE
    override val spec = ToolSpec(
        name = "phone_open",
        description = "Open a launchable app by package name. Requires one-time user approval.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf("package" to mapOf("type" to "string")),
            "required" to listOf("package"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        // Do not reject just because DSH itself is in front: this tool's job is
        // to leave the DSH app. Other phone tools still guard the active screen.
        val before = PhoneBridge.stableSnapshot()
        // A live background display may have no application window between
        // apps. Opening a target is exactly how it gets one, so only fail
        // when the display itself is unavailable (or this is the main screen).
        if (before.error != null && (!PhoneBridge.isBackground() || PhoneBridge.currentDisplayId() <= 0)) {
            return ToolOutput(ToolStatus.ERROR, before.error)
        }
        if (before.error == null && before.locked) {
            return ToolOutput(ToolStatus.ERROR, "SCREEN_LOCKED: unlock the phone first")
        }
        val packageName = stringArgument(call, "package")
            ?: return ToolOutput(ToolStatus.ERROR, "INVALID_PACKAGE")
        val result = PhoneBridge.openApp(context, packageName)
        if (result != "OK") return ToolOutput(ToolStatus.ERROR, result)
        if (PhoneBridge.isSensitivePackage(packageName)) {
            Thread.sleep(500)
            val resumed = handoff.await("打开的是系统或安全设置，需要你接管手机")
            return ToolOutput(
                ToolStatus.DENIED,
                "OPENED_SENSITIVE: $packageName; system or security settings" +
                    if (resumed) " (handoff resumed)" else " (handoff stopped)",
            )
        }
        // The launch command returns before the target activity is drawn. Wait
        // for the requested package instead of returning the previous app.
        val screen = PhoneBridge.waitForPackage(packageName, attempts = 20, delayMs = 250)
        if (screen.error != null) return ToolOutput(ToolStatus.ERROR, screen.error)
        if (screen.packageName != packageName) {
            return ToolOutput(
                ToolStatus.ERROR,
                "OPEN_TIMEOUT: $packageName did not become foreground\n" + PhoneBridge.screenJson(screen),
            )
        }
        if (screen.sensitive) {
            val reason = screen.sensitiveReason ?: "sensitive screen"
            val resumed = handoff.await("打开后进入敏感页面，需要你接管：$reason")
            return ToolOutput(
                ToolStatus.DENIED,
                "OPENED_SENSITIVE: $packageName; $reason" +
                    if (resumed) " (handoff resumed)" else " (handoff stopped)",
            )
        }
        return ToolOutput(ToolStatus.OK, "OPENED $packageName\n" + PhoneBridge.screenJson(screen))
    }
}

private class PhoneTapTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.PHONE
    override val spec = ToolSpec(
        name = "phone_tap",
        description = "Tap an element id from phone_screen. Only element ids are accepted, never coordinates. Requires one-time approval.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf("element" to mapOf("type" to "string")),
            "required" to listOf("element"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        guard(handoff)?.let { return it }
        val element = stringArgument(call, "element")
            ?: return ToolOutput(ToolStatus.ERROR, "INVALID_ELEMENT")
        val result = OutpostAccessibilityService.instance?.tap(element, PhoneBridge.currentDisplayId())
            ?: return ToolOutput(ToolStatus.ERROR, "ACCESSIBILITY_NOT_CONNECTED")
        if (result != "OK" && result != "OK_GESTURE") return ToolOutput(ToolStatus.ERROR, result)
        Thread.sleep(350)
        return screenOutput("TAPPED $element ($result)")
    }
}

private class PhoneTypeTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.PHONE
    override val spec = ToolSpec(
        name = "phone_type",
        description = "Set text in an editable element id (or the focused editable field). Requires one-time approval.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf(
                "element" to mapOf("type" to "string"),
                "text" to mapOf("type" to "string"),
            ),
            "required" to listOf("text"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        guard(handoff)?.let { return it }
        val text = call.arguments["text"] as? String ?: return ToolOutput(ToolStatus.ERROR, "INVALID_TEXT")
        val element = stringArgument(call, "element")
        val result = OutpostAccessibilityService.instance?.type(element, text, PhoneBridge.currentDisplayId())
            ?: return ToolOutput(ToolStatus.ERROR, "ACCESSIBILITY_NOT_CONNECTED")
        if (result == "PASSWORD_FIELD_BLOCKED") {
            val resumed = handoff.await("需要你接管手机：密码输入框")
            return ToolOutput(
                ToolStatus.DENIED,
                "PASSWORD_FIELD: the action was not executed" +
                    if (resumed) " (handoff resumed)" else " (handoff stopped)",
            )
        }
        if (result != "OK") return ToolOutput(ToolStatus.ERROR, result)
        Thread.sleep(250)
        return screenOutput("TYPED${element?.let { " $it" } ?: ""}")
    }
}

private class PhoneScrollTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.PHONE
    override val spec = ToolSpec(
        name = "phone_scroll",
        description = "Scroll the first scrollable element: up/down/left/right. Requires one-time approval.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf(
                "direction" to mapOf("type" to "string", "enum" to listOf("up", "down", "left", "right")),
            ),
            "required" to listOf("direction"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        guard(handoff)?.let { return it }
        val direction = stringArgument(call, "direction")
            ?: return ToolOutput(ToolStatus.ERROR, "INVALID_DIRECTION")
        val result = OutpostAccessibilityService.instance?.scroll(direction, PhoneBridge.currentDisplayId())
            ?: return ToolOutput(ToolStatus.ERROR, "ACCESSIBILITY_NOT_CONNECTED")
        if (result != "OK") return ToolOutput(ToolStatus.ERROR, result)
        Thread.sleep(300)
        return screenOutput("SCROLLED $direction")
    }
}

private class PhoneKeyTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.PHONE
    override val spec = ToolSpec(
        name = "phone_key",
        description = "Perform a global key: back/home/recents. No arbitrary keycodes. Requires one-time approval.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf(
                "key" to mapOf("type" to "string", "enum" to listOf("back", "home", "recents")),
            ),
            "required" to listOf("key"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val key = stringArgument(call, "key") ?: return ToolOutput(ToolStatus.ERROR, "INVALID_KEY")
        val displayId = PhoneBridge.currentDisplayId()
        if (displayId > 0 && displayId != Display.DEFAULT_DISPLAY &&
            (key.lowercase() == "home" || key.lowercase() == "recents")
        ) {
            return ToolOutput(ToolStatus.ERROR, "BACKGROUND_KEY_UNSUPPORTED")
        }
        guard(handoff)?.let { return it }
        val result = OutpostAccessibilityService.instance?.key(key, displayId)
            ?: return ToolOutput(ToolStatus.ERROR, "ACCESSIBILITY_NOT_CONNECTED")
        if (result != "OK") return ToolOutput(ToolStatus.ERROR, result)
        Thread.sleep(500)
        return keyOutput("KEY $key", displayId)
    }
}

private class PhoneHandoffTool(private val handoff: HandoffGate) : AgentTool {
    override val risk = ToolRisk.READ
    override val spec = ToolSpec(
        name = "phone_handoff",
        description = "Pause and hand the phone back to the user, for example before a login, payment, or sensitive decision. The run resumes only when the user taps continue.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf("reason" to mapOf("type" to "string")),
            "required" to listOf("reason"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val reason = stringArgument(call, "reason") ?: "user handoff requested"
        val resumed = handoff.await("需要你接管手机：$reason")
        return if (resumed) {
            ToolOutput(ToolStatus.OK, "HANDOFF_COMPLETE")
        } else {
            ToolOutput(ToolStatus.DENIED, "HANDOFF_STOPPED")
        }
    }
}
