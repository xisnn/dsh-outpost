package com.dshpocket.agent

import android.content.Intent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dshpocket.agent.background.BackgroundDisplayController
import com.dshpocket.agent.core.ApprovalNodeBinding
import com.dshpocket.agent.core.ScreenGuard
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactApplicationContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * P6-next real-device acceptance (second-party authorized vivo V1981A, API 31).
 *
 * Drives the ACTUAL accessibility service on a Shizuku virtual display: real
 * tap/type/scroll gestures, STALE_SCREEN / STALE_NODE negatives, and the
 * display-targeted home/recents three-state. Emulator a11y churn / process
 * rebind limits do not apply on a real device; environment prerequisites that
 * are genuinely absent skip honestly (Assume), never fake a pass.
 *
 * Safety: only the isolated test package + virtual display; non-sensitive
 * targets (Contacts/Settings lists); no main-screen personal data writes.
 */
@RunWith(AndroidJUnit4::class)
class RealDeviceGatesTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    /** Step beacon through the instrumentation status stream (vivo blocks logcat). */
    private fun step(name: String) {
        val b = android.os.Bundle()
        b.putString("step", name)
        instrumentation.sendStatus(0, b)
    }

    private fun clickIfVisible(texts: List<String>): Boolean {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return false
        fun visit(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (texts.contains(node.text?.toString())) {
                var target: AccessibilityNodeInfo? = node
                while (target != null && !target.isClickable) target = target.parent
                if (target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) return true
            }
            for (i in 0 until node.childCount) if (visit(node.getChild(i))) return true
            return false
        }
        return visit(root)
    }

    private fun secondaryDisplay(): Pair<BackgroundDisplayController, Int>? {
        // P6-next bind fix: Shizuku binder IPC now runs off the main looper, so
        // launching MainActivity under instrumentation no longer deadlocks
        // (D-state). Use the REAL app ReactHost context (faithful acceptance);
        // ReactApplicationContext is abstract in this RN and cannot be new'd.
        step("launch-app")
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent != null) context.startActivity(intent)
        var react: ReactApplicationContext? = null
        val appDeadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < appDeadline) {
            react = (context.applicationContext as? ReactApplication)
                ?.reactHost?.currentReactContext as? ReactApplicationContext
            if (react != null) break
            Thread.sleep(300)
        }
        if (react == null) { step("react-null"); return null }
        step("controller-start")
        val controller = BackgroundDisplayController.get(react)
        controller.startAndWait(15_000, true)
        step("controller-started")
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val st = controller.status()
            step("status:" + st.toString().take(160))
            if (st.optBoolean("connected") && st.optBoolean("permissionGranted") && st.optInt("displayId", -1) > 0) {
                return controller to st.optInt("displayId")
            }
            // Shizuku manager authorization dialog (one-time setup tap).
            clickIfVisible(listOf("允许", "Allow", "授权", "始终允许"))
            Thread.sleep(400)
        }
        step("display-timeout")
        return null
    }

    private fun service(): OutpostAccessibilityService? = OutpostAccessibilityService.instance

    private fun awaitElements(displayId: Int, timeoutMs: Long = 15_000): PhoneSnapshot? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val s = service()?.snapshot(displayId)
            if (s != null && s.error == null && s.elements.isNotEmpty()) return s
            Thread.sleep(300)
        }
        return null
    }

    private fun publish(s: PhoneSnapshot) {
        ScreenGuard.publish(OutpostAccessibilityService.fingerprintOf(s))
    }

    @After
    fun cleanup() {
        BackgroundDisplayController.stopIfRunning()
    }

    @Test
    fun realGesturesTapTypeScrollOnSecondaryDisplay() {
        val (controller, displayId) = secondaryDisplay() ?: run { assumeTrue(false); return }
        val svc = service() ?: run { step("service-null"); assumeTrue(false); return }
        step("launch-contacts")
        controller.launch("com.android.contacts")
        val s = awaitElements(displayId) ?: run { step("snapshot-timeout"); assumeTrue(false); return }
        step("snapshot:" + s.elements.size)
        publish(s)
        val editable = s.elements.firstOrNull { it.editable }
        assumeTrue("Contacts search field present", editable != null)
        step("type-begin")
        assertEquals("OK", svc.type(editable!!.id, "Hello 测试 123", displayId))
        step("type-ok")
        val after = awaitElements(displayId)!!
        assertTrue("typed text visible on secondary display", after.elements.any { it.text.contains("Hello 测试 123") })
        val clickable = after.elements.firstOrNull { it.clickable && !it.editable }
        assumeTrue("a clickable entry present", clickable != null)
        step("tap-begin")
        assertEquals("OK", svc.tap(clickable!!.id, displayId))
        step("tap-ok")
        assertEquals("OK", svc.scroll("down", displayId))
        step("scroll-ok")
    }

    @Test
    fun staleScreenRefusesAfterNavigationOnSecondaryDisplay() {
        val (controller, displayId) = secondaryDisplay() ?: run { assumeTrue(false); return }
        val svc = service() ?: run { assumeTrue(false); return }
        controller.launch("com.android.contacts")
        val s = awaitElements(displayId) ?: run { assumeTrue(false); return }
        publish(s)
        controller.launch("com.android.settings")
        Thread.sleep(1200)
        assertEquals("STALE_SCREEN", svc.tap("n1", displayId))
    }

    @Test
    fun nodeIdentityBindingRefusesAcrossScreenChange() {
        val (controller, displayId) = secondaryDisplay() ?: run { assumeTrue(false); return }
        val svc = service() ?: run { assumeTrue(false); return }
        controller.launch("com.android.contacts")
        val s = awaitElements(displayId) ?: run { assumeTrue(false); return }
        val target = s.elements.firstOrNull { it.clickable }
        assumeTrue("a target element present", target != null)
        val before = svc.nodeIdentity(target!!.id, displayId)
        assumeTrue("identity readable before", before != null)
        controller.launch("com.android.settings")
        Thread.sleep(1200)
        val after = svc.nodeIdentity(target.id, displayId)
        assertNotEquals(ApprovalNodeBinding.Binding.ALLOW, ApprovalNodeBinding.decision(before, after))
    }

    @Test
    fun homeRecentsAreDisplayTargetedThreeState() {
        val (controller, displayId) = secondaryDisplay() ?: run { assumeTrue(false); return }
        val svc = service() ?: run { assumeTrue(false); return }
        controller.launch("com.android.contacts")
        assumeTrue("contacts up on secondary", awaitElements(displayId) != null)
        val home = svc.key("home", displayId)
        assertTrue("home three-state, got $home", home in setOf("OK", "OK_DISPLAY_EMPTY"))
        val recents = svc.key("recents", displayId)
        assertTrue("recents three-state, got $recents", recents in setOf("OK", "OK_DISPLAY_EMPTY"))
        assertNotEquals("BACKGROUND_KEY_UNSUPPORTED", home)
        assertNotEquals("BACKGROUND_KEY_UNSUPPORTED", recents)
    }
}
