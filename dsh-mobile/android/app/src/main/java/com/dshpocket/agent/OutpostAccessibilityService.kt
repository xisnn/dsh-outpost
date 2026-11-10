package com.dshpocket.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.atomic.AtomicInteger

data class PhoneElement(
    val id: String,
    val text: String,
    val description: String,
    val className: String,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val enabled: Boolean,
    val isPassword: Boolean,
    val bounds: Rect,
)

data class PhoneSnapshot(
    val screenId: Int,
    val packageName: String?,
    val elements: List<PhoneElement>,
    val sensitive: Boolean,
    val sensitiveReason: String?,
    val locked: Boolean,
    val truncated: Boolean,
    val error: String?,
    val displayId: Int = Display.DEFAULT_DISPLAY,
)

/**
 * P6-2 accessibility adapter. It only exposes the active window's node tree
 * and element actions; there is no shell, arbitrary keycode, or model-supplied
 * coordinate path.
 */
class OutpostAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: OutpostAccessibilityService? = null
            private set

        fun isEnabled(context: android.content.Context): Boolean {
            val manager = context.getSystemService(AccessibilityManager::class.java) ?: return false
            return try {
                manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
                    .any { info ->
                        val service = info.resolveInfo?.serviceInfo ?: return@any false
                        service.packageName == context.packageName &&
                            service.name == OutpostAccessibilityService::class.java.name
                    }
            } catch (_: Exception) {
                false
            }
        }

        private const val MAX_ELEMENTS = 120
        private const val MAX_DEPTH = 40
        private const val MAX_TEXT = 160
        private const val MAX_TYPE_CHARS = 2000
        private val SENSITIVE_KEYWORDS = listOf(
            "密码", "验证码", "支付", "付款", "转账", "银行卡", "余额", "安全码",
            "password", "passcode", "pin", "verification code", "payment", "bank card",
        )
    }

    private val screenCounter = AtomicInteger(0)

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i("DshPhoneA11y", "service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // State is read on demand by the agent; event streams are not logged.
    }

    override fun onInterrupt() {
        // No queued accessibility work to cancel.
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        Log.i("DshPhoneA11y", "service destroyed")
        super.onDestroy()
    }

    fun snapshot(displayId: Int = Display.DEFAULT_DISPLAY): PhoneSnapshot {
        val id = screenCounter.incrementAndGet()
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (keyguard?.isKeyguardLocked == true) {
            return PhoneSnapshot(id, null, emptyList(), true, "screen is locked", true, false, null, displayId)
        }
        val root = rootFor(displayId)
            ?: return PhoneSnapshot(id, null, emptyList(), false, null, false, false, "ACCESSIBILITY_NO_ACTIVE_WINDOW", displayId)
        val elements = mutableListOf<PhoneElement>()
        var truncated = false
        fun visit(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || elements.size >= MAX_ELEMENTS) {
                if (node != null) truncated = true
                return
            }
            if (depth > MAX_DEPTH) {
                truncated = true
                return
            }
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val text = node.text?.toString()?.trim().orEmpty()
            val description = node.contentDescription?.toString()?.trim().orEmpty()
            val interesting = text.isNotEmpty() || description.isNotEmpty() ||
                node.isClickable || node.isEditable || node.isScrollable || node.isPassword
            if (interesting && node.isVisibleToUser && bounds.width() > 0 && bounds.height() > 0) {
                elements += PhoneElement(
                    id = "n${elements.size + 1}",
                    text = text.take(MAX_TEXT),
                    description = description.take(MAX_TEXT),
                    className = node.className?.toString()?.take(160).orEmpty(),
                    clickable = node.isClickable,
                    editable = node.isEditable,
                    scrollable = node.isScrollable,
                    enabled = node.isEnabled,
                    isPassword = node.isPassword,
                    bounds = Rect(bounds),
                )
            }
            for (index in 0 until node.childCount) {
                visit(node.getChild(index), depth + 1)
            }
        }
        try {
            visit(root, 0)
        } finally {
            // AccessibilityNodeInfo.recycle is deprecated/no-op on modern
            // Android; no explicit recycle is needed here.
        }
        val pkg = root.packageName?.toString()
        val reason = sensitiveReason(pkg, elements)
        return PhoneSnapshot(
            screenId = id,
            packageName = pkg,
            elements = elements,
            sensitive = reason != null,
            sensitiveReason = reason,
            locked = false,
            truncated = truncated,
            error = null,
            displayId = displayId,
        )
    }

    fun tap(elementId: String, displayId: Int = Display.DEFAULT_DISPLAY): String {
        val root = rootFor(displayId) ?: return "ACCESSIBILITY_NO_ACTIVE_WINDOW"
        val node = findElement(root, elementId) ?: return "STALE_ELEMENT"
        if (!node.isEnabled) return "ELEMENT_DISABLED"
        val target = if (node.isClickable) node else clickableAncestor(node)
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return "OK"
        }
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.width() <= 0 || bounds.height() <= 0) return "ELEMENT_HAS_NO_BOUNDS"
        val path = Path().apply {
            moveTo(bounds.exactCenterX(), bounds.exactCenterY())
        }
        val gesture = GestureDescription.Builder()
            .setDisplayId(displayId)
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        return if (dispatchGesture(gesture, null, null)) "OK_GESTURE" else "GESTURE_FAILED"
    }

    fun type(elementId: String?, text: String, displayId: Int = Display.DEFAULT_DISPLAY): String {
        if (text.length > MAX_TYPE_CHARS) return "TEXT_TOO_LONG"
        val root = rootFor(displayId) ?: return "ACCESSIBILITY_NO_ACTIVE_WINDOW"
        var node = (if (elementId.isNullOrBlank()) findFocusedEditable(root) else findElement(root, elementId))
            ?: return if (elementId.isNullOrBlank()) "NO_FOCUSED_EDITABLE" else "STALE_ELEMENT"
        if (!node.isEditable) {
            node = findEditableInSubtree(node) ?: return "ELEMENT_NOT_EDITABLE"
        }
        if (node.isPassword) return "PASSWORD_FIELD_BLOCKED"
        if (!node.isEnabled) return "ELEMENT_DISABLED"

        var actionAccepted = setTextOnNode(node, text)
        if (actionAccepted && textMatches(node, text)) {
            Log.i("DshPhoneA11y", "type display=$displayId element=${elementId ?: "focused"} result=OK")
            return "OK"
        }

        // Some fields (notably a collapsed Contacts SearchView) do not accept
        // setText until an actual click expands/focuses the real input. Click,
        // wait for the new window, then set text on the focused editable node.
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var current = node
        repeat(10) {
            Thread.sleep(400)
            val freshRoot = rootFor(displayId) ?: return@repeat
            val fresh = findFocusedEditable(freshRoot)
                ?: findFirstEditable(freshRoot)
                ?: (elementId?.let { id -> findElement(freshRoot, id)?.let { findEditableInSubtree(it) } })
            if (fresh == null) return@repeat
            if (fresh.isPassword) return "PASSWORD_FIELD_BLOCKED"
            current = fresh
            val ok = setTextOnNode(fresh, text)
            actionAccepted = ok || actionAccepted
            if (ok && textMatches(fresh, text)) {
                Log.i("DshPhoneA11y", "type display=$displayId result=OK_AFTER_CLICK")
                return "OK"
            }
        }

        if (pasteText(current, text)) {
            Log.i("DshPhoneA11y", "type display=$displayId result=OK_CLIPBOARD")
            return "OK"
        }
        // The shell `input text` path only supports printable ASCII. It types
        // into the focused field on the virtual display without the main IME.
        if (displayId != Display.DEFAULT_DISPLAY && text.all { it.code in 0x20..0x7E }) {
            val shell = PhoneBridge.backgroundText(text)
            if (shell == "OK" && waitForText(current, text)) {
                Log.i("DshPhoneA11y", "type display=$displayId result=OK_SHELL")
                return "OK"
            }
        }
        Log.i(
            "DshPhoneA11y",
            "type display=$displayId element=${elementId ?: "focused"} result=${
                if (actionAccepted) "SET_TEXT_UNVERIFIED" else "SET_TEXT_FAILED"
            }",
        )
        return if (actionAccepted) "SET_TEXT_UNVERIFIED" else "SET_TEXT_FAILED"
    }

    private fun setTextOnNode(node: AccessibilityNodeInfo, text: String): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        var ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
        if (!ok || !textMatches(node, text)) {
            // Some fields need an actual click before the input connection is
            // ready, even though setText is an accessibility action.
            node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Thread.sleep(120)
            node.refresh()
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments) || ok
            Thread.sleep(120)
        }
        node.refresh()
        return ok
    }

    private fun textMatches(node: AccessibilityNodeInfo, text: String): Boolean {
        runCatching { node.refresh() }
        val current = node.text?.toString().orEmpty()
        return if (text.isEmpty()) current.isEmpty() else current == text || current.contains(text)
    }

    private fun waitForText(node: AccessibilityNodeInfo, text: String): Boolean {
        repeat(6) {
            if (textMatches(node, text)) return true
            Thread.sleep(120)
        }
        return false
    }

    private fun pasteText(node: AccessibilityNodeInfo, text: String): Boolean {
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return false
        return try {
            clipboard.setPrimaryClip(ClipData.newPlainText("dsh-agent-text", text))
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            val matched = pasted && waitForText(node, text)
            matched
        } catch (_: Throwable) {
            false
        } finally {
            // Do not leave potentially sensitive text on the system clipboard.
            runCatching {
                if (Build.VERSION.SDK_INT >= 28) {
                    clipboard.clearPrimaryClip()
                } else {
                    clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }
        }
    }

    private fun findEditableInSubtree(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (index in 0 until node.childCount) {
            findEditableInSubtree(node.getChild(index) ?: continue)?.let { return it }
        }
        return null
    }

    private fun findFirstEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable && root.isVisibleToUser) return root
        for (index in 0 until root.childCount) {
            findFirstEditable(root.getChild(index) ?: continue)?.let { return it }
        }
        return null
    }

    fun scroll(direction: String, displayId: Int = Display.DEFAULT_DISPLAY): String {
        val root = rootFor(displayId) ?: return "ACCESSIBILITY_NO_ACTIVE_WINDOW"
        val node = findScrollable(root) ?: return "NO_SCROLLABLE"
        val action = when (direction.lowercase()) {
            "up", "backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "down", "forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            else -> return "INVALID_DIRECTION"
        }
        return if (node.performAction(action)) "OK" else "SCROLL_FAILED"
    }

    fun key(key: String, displayId: Int = Display.DEFAULT_DISPLAY): String {
        if (displayId != Display.DEFAULT_DISPLAY) {
            return PhoneBridge.backgroundKey(key)
        }
        val action = when (key.lowercase()) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            else -> return "INVALID_KEY"
        }
        return if (performGlobalAction(action)) "OK" else "KEY_FAILED"
    }

    /**
     * rootInActiveWindow only follows the default display. Background tools
     * must select the application window on the requested virtual display.
     */
    private fun rootFor(displayId: Int): AccessibilityNodeInfo? {
        if (displayId == Display.DEFAULT_DISPLAY) return rootInActiveWindow
        val all = try {
            windowsOnAllDisplays
        } catch (error: Throwable) {
            Log.w("DshPhoneA11y", "windowsOnAllDisplays failed", error)
            return null
        }
        val windows = all.get(displayId).orEmpty()
        val root = windows.asSequence()
            .sortedByDescending { it.layer }
            .firstNotNullOfOrNull { window ->
                if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION) window.root else null
            }
        Log.i("DshPhoneA11y", "rootFor display=$displayId displays=${all.size()} windows=${windows.size} root=${root != null}")
        return root
    }

    private fun findElement(root: AccessibilityNodeInfo, elementId: String): AccessibilityNodeInfo? {
        var current = 0
        fun visit(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val text = node.text?.toString()?.trim().orEmpty()
            val description = node.contentDescription?.toString()?.trim().orEmpty()
            val interesting = text.isNotEmpty() || description.isNotEmpty() ||
                node.isClickable || node.isEditable || node.isScrollable || node.isPassword
            if (interesting && node.isVisibleToUser && bounds.width() > 0 && bounds.height() > 0) {
                current += 1
                if ("n$current" == elementId) return node
            }
            for (index in 0 until node.childCount) {
                visit(node.getChild(index))?.let { return it }
            }
            return null
        }
        return visit(root)
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var parent = node.parent
        var depth = 0
        while (parent != null && depth < 8) {
            if (parent.isClickable) return parent
            parent = parent.parent
            depth += 1
        }
        return null
    }

    private fun findFocusedEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        fun visit(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isEditable && node.isFocused) return node
            for (index in 0 until node.childCount) {
                visit(node.getChild(index))?.let { return it }
            }
            return null
        }
        return visit(root)
    }

    private fun findScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        fun visit(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isScrollable) return node
            for (index in 0 until node.childCount) {
                visit(node.getChild(index))?.let { return it }
            }
            return null
        }
        return visit(root)
    }

    private fun sensitiveReason(packageName: String?, elements: List<PhoneElement>): String? {
        if (packageName == null) return "unknown foreground package"
        if (packageName == this.packageName) return "DSH Outpost itself"
        if (PhoneBridge.isSensitivePackage(packageName)) {
            return "system or security settings"
        }
        if (elements.any { it.isPassword }) return "password field"
        val keyword = elements.firstOrNull {
            val value = (it.text + " " + it.description).lowercase()
            SENSITIVE_KEYWORDS.any { word -> value.contains(word) }
        }
        return keyword?.let { "sensitive screen content" }
    }

}
