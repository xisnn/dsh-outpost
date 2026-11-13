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
import com.dshpocket.agent.core.ScreenGuard
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

        /**
         * P4-0.1 P0-3A: identity of a snapshot for screen-generation binding.
         * Mirrors exactly what [screenJson] shows the model, so "the screen the
         * model saw" and "the screen we compare against" are the same object.
         */
        fun fingerprintOf(s: PhoneSnapshot): String = ScreenGuard.fingerprint(
            s.packageName,
            s.displayId,
            s.locked,
            s.sensitive,
            s.elements.map {
                ScreenGuard.ElementSig(
                    id = it.id,
                    text = it.text,
                    description = it.description,
                    className = it.className,
                    bounds = it.bounds.toShortString(),
                    flags = "${it.clickable}${it.editable}${it.scrollable}${it.enabled}${it.isPassword}",
                )
            },
        )
    }

    /**
     * True when the live screen no longer matches the last snapshot published to
     * the model. Actions then refuse with STALE_SCREEN instead of re-resolving
     * positional ids against a tree the model never saw.
     */
    private fun isStaleScreen(displayId: Int): Boolean {
        val s = snapshot(displayId)
        if (s.error != null) return false
        return ScreenGuard.isStale(fingerprintOf(s))
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
        if (isStaleScreen(displayId)) return "STALE_SCREEN"
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
        if (isStaleScreen(displayId)) return "STALE_SCREEN"
        var node = (if (elementId.isNullOrBlank()) findFocusedEditable(root) else findElement(root, elementId))
            ?: return if (elementId.isNullOrBlank()) "NO_FOCUSED_EDITABLE" else "STALE_ELEMENT"
        if (!node.isEditable) {
            node = findEditableInSubtree(node) ?: return "ELEMENT_NOT_EDITABLE"
        }
        if (node.isPassword) return "PASSWORD_FIELD_BLOCKED"
        if (!node.isEnabled) return "ELEMENT_DISABLED"

        var actionAccepted = setTextOnNode(node, text)
        val firstAttempt = matchText(node, text)
        if (actionAccepted && firstAttempt == TextMatch.EXACT) {
            Log.i("DshPhoneA11y", "type display=$displayId element=${elementId ?: "focused"} result=OK")
            return "OK"
        }
        if (firstAttempt == TextMatch.CONTAINS) return unverified(displayId, elementId, "field holds extra text")

        // Some fields (notably a collapsed Contacts SearchView) do not accept
        // setText until an actual click expands/focuses the real input. Click,
        // wait for the new window, then set text on the focused editable node.
        val originalPackage = root.packageName?.toString()
        // P4-0.1 P0-3A: same-package navigation is still a different screen. The
        // window id changes on activity/window switches but not on in-place
        // expansion (e.g. a SearchView), so it separates "the field moved to
        // another window" from "the same field expanded".
        val originalWindowId = root.windowId
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var current = node
        repeat(10) {
            Thread.sleep(400)
            val freshRoot = rootFor(displayId) ?: return@repeat
            // The click may have navigated away. Everything below is positional or
            // "first editable in the window", so continuing would type into an
            // unrelated field in another app, and nK means something else entirely
            // in a different tree. Abort before any text is written.
            val freshPackage = freshRoot.packageName?.toString()
            if (originalPackage != null && freshPackage != originalPackage) {
                Log.w(
                    "DshPhoneA11y",
                    "type display=$displayId aborted: window changed $originalPackage -> $freshPackage",
                )
                return "SCREEN_CHANGED_DURING_TYPE"
            }
            if (freshRoot.windowId != originalWindowId) {
                Log.w(
                    "DshPhoneA11y",
                    "type display=$displayId aborted: same package but window changed " +
                        "$originalWindowId -> ${freshRoot.windowId}",
                )
                return "SCREEN_CHANGED_DURING_TYPE"
            }
            val fresh = findFocusedEditable(freshRoot)
                ?: findFirstEditable(freshRoot)
                ?: (elementId?.let { id -> findElement(freshRoot, id)?.let { findEditableInSubtree(it) } })
            if (fresh == null) return@repeat
            if (fresh.isPassword) return "PASSWORD_FIELD_BLOCKED"
            current = fresh
            val ok = setTextOnNode(fresh, text)
            actionAccepted = ok || actionAccepted
            val afterClick = matchText(fresh, text)
            if (ok && afterClick == TextMatch.EXACT) {
                Log.i("DshPhoneA11y", "type display=$displayId result=OK_AFTER_CLICK")
                return "OK"
            }
            if (afterClick == TextMatch.CONTAINS) return unverified(displayId, elementId, "field holds extra text after click")
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

    /**
     * ACTION_SET_TEXT replaces the field, so the extra characters were not
     * written by this call. Retrying through click, paste or the shell would risk
     * duplicating or clobbering what the app already put there; report the
     * unverified state and let the model re-snapshot instead.
     */
    private fun unverified(displayId: Int, elementId: String?, detail: String): String {
        Log.w(
            "DshPhoneA11y",
            "type display=$displayId element=${elementId ?: "focused"} result=SET_TEXT_UNVERIFIED ($detail)",
        )
        return "SET_TEXT_UNVERIFIED"
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

    private enum class TextMatch { EXACT, CONTAINS, MISMATCH }

    /**
     * [TextMatch.CONTAINS] means the field holds our text plus something else, so
     * the write cannot be confirmed. Only the two verdict sites in [type] care
     * about the distinction; the internal retry and paste/shell checks below treat
     * CONTAINS as success because ACTION_PASTE and `input text` append by design.
     */
    private fun matchText(node: AccessibilityNodeInfo, text: String): TextMatch {
        runCatching { node.refresh() }
        val current = node.text?.toString().orEmpty()
        return when {
            text.isEmpty() -> if (current.isEmpty()) TextMatch.EXACT else TextMatch.MISMATCH
            current == text -> TextMatch.EXACT
            current.contains(text) -> TextMatch.CONTAINS
            else -> TextMatch.MISMATCH
        }
    }

    private fun textMatches(node: AccessibilityNodeInfo, text: String): Boolean =
        matchText(node, text) != TextMatch.MISMATCH

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
        if (isStaleScreen(displayId)) return "STALE_SCREEN"
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
        if (isStaleScreen(displayId)) return "STALE_SCREEN"
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

    /**
     * Resolves a positional id back to a node. The walk must mirror [snapshot]
     * exactly, caps included: ids only mean something within the traversal that
     * produced them, so an id past the snapshot's limit would otherwise resolve
     * to a node the model was never shown and act on it blind.
     */
    private fun findElement(root: AccessibilityNodeInfo, elementId: String): AccessibilityNodeInfo? {
        var current = 0
        fun visit(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
            if (node == null || current >= MAX_ELEMENTS) return null
            if (depth > MAX_DEPTH) return null
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
                visit(node.getChild(index), depth + 1)?.let { return it }
            }
            return null
        }
        return visit(root, 0)
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
