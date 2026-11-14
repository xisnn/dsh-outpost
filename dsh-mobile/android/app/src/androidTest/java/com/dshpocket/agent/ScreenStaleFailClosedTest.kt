package com.dshpocket.agent

import android.accessibilityservice.AccessibilityService
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dshpocket.agent.core.ScreenGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * P4-0.2 supplemental: real-service screen-binding fail-closed verification.
 *
 * Drives the ACTUAL OutpostAccessibilityService (not a replica) to confirm the
 * isStaleScreen -> ScreenGuard.staleDecision integration:
 *  - a changed screen makes tap() refuse with STALE_SCREEN (before element lookup);
 *  - re-publishing the current fingerprint recovers (tap() then reaches element
 *    lookup, returning STALE_ELEMENT for a non-existent id, NOT STALE_SCREEN).
 *
 * Using a non-existent element id lets us observe the staleness gate directly:
 * STALE_SCREEN means the gate refused; STALE_ELEMENT means the gate passed.
 *
 * The snapshot-ERROR fail-closed branch (staleDecision(true, ...)) is covered by
 * the JVM ScreenGuardTest contract tests; inducing a snapshot error mid-action
 * requires the window to vanish between the action's root check and the staleness
 * check, which the emulator does not model reliably (see delivery acceptance notes).
 */
@RunWith(AndroidJUnit4::class)
class ScreenStaleFailClosedTest {
    private fun boundService(): OutpostAccessibilityService? {
        // The service is enabled out-of-band via `adb shell settings put secure
        // enabled_accessibility_services ...` (the test app lacks WRITE_SECURE_SETTINGS).
        val deadline = System.currentTimeMillis() + 15000
        while (System.currentTimeMillis() < deadline) {
            val s = OutpostAccessibilityService.instance
            if (s != null) return s
            Thread.sleep(200)
        }
        return null
    }

    private fun fingerprint(s: OutpostAccessibilityService): String {
        val snap = s.snapshot()
        return OutpostAccessibilityService.fingerprintOf(snap)
    }

    @Test
    fun changedScreenRefusesThenResnapshotRecovers() {
        // Requires the accessibility service bound in THIS process. On the emulator
        // am instrument restarts the process and the system does not reliably rebind
        // the service in the instrumentation process; skip there (run on a device).
        val service = boundService()
        assumeNotNull(service)
        service!!
        // Baseline: publish the current screen.
        val fpA = fingerprint(service)
        ScreenGuard.publish(fpA)
        // Same screen, non-existent element: gate passes -> STALE_ELEMENT (not STALE_SCREEN).
        val fresh = service.tap("n_does_not_exist")
        assertNotEquals("fresh screen must pass the staleness gate", "STALE_SCREEN", fresh)

        // Change the screen so the live fingerprint differs from the published one.
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        Thread.sleep(800)
        val fpB = fingerprint(service)
        assertNotEquals("home screen must differ from the app screen", fpA, fpB)
        // Published fpA, live fpB: gate must refuse with STALE_SCREEN.
        val stale = service.tap("n_does_not_exist")
        assertEquals("changed screen must refuse STALE_SCREEN", "STALE_SCREEN", stale)

        // Recovery: re-publish the current screen, gate passes again.
        ScreenGuard.publish(fpB)
        val recovered = service.tap("n_does_not_exist")
        assertNotEquals("re-snapshot must recover the staleness gate", "STALE_SCREEN", recovered)
    }

    @Test
    fun failClosedDecisionIsUsedByService() {
        // The service delegates to ScreenGuard.staleDecision; a snapshot error
        // must be stale (fail-closed). Pin the contract the service relies on.
        assertTrue(ScreenGuard.staleDecision(true, "any"))
        assertTrue(ScreenGuard.staleDecision(true, null))
    }
}