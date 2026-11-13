package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ScreenGuardTest {
    private fun sig(id: String, text: String, bounds: String = "[0,0][10,10]") =
        ScreenGuard.ElementSig(id, text, "", "android.widget.Button", bounds, "truefalsefalsetruefalse")

    @Before
    fun reset() {
        ScreenGuard.reset()
    }

    @Test
    fun `no published snapshot means every action is stale`() {
        val fp = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        assertTrue(ScreenGuard.isStale(fp))
    }

    @Test
    fun `identical screen is not stale after publish`() {
        val fp = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        ScreenGuard.publish(fp)
        assertFalse(ScreenGuard.isStale(fp))
    }

    @Test
    fun `same package but changed element text is stale`() {
        val before = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        val after = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "Confirm")))
        ScreenGuard.publish(before)
        assertNotEquals(before, after)
        assertTrue(ScreenGuard.isStale(after))
    }

    @Test
    fun `same package but moved bounds is stale`() {
        val before = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK", "[0,0][10,10]")))
        val after = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK", "[0,400][10,410]")))
        ScreenGuard.publish(before)
        assertTrue(ScreenGuard.isStale(after))
    }

    @Test
    fun `element added or removed is stale`() {
        val before = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        val after = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK"), sig("n2", "Cancel")))
        ScreenGuard.publish(before)
        assertTrue(ScreenGuard.isStale(after))
    }

    @Test
    fun `package change is stale`() {
        val before = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        val after = ScreenGuard.fingerprint("com.other", 0, false, false, listOf(sig("n1", "OK")))
        ScreenGuard.publish(before)
        assertTrue(ScreenGuard.isStale(after))
    }

    @Test
    fun `lock and sensitivity changes are stale`() {
        val base = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        ScreenGuard.publish(base)
        assertTrue(ScreenGuard.isStale(ScreenGuard.fingerprint("com.example", 0, true, false, listOf(sig("n1", "OK")))))
        assertTrue(ScreenGuard.isStale(ScreenGuard.fingerprint("com.example", 0, false, true, listOf(sig("n1", "OK")))))
    }

    @Test
    fun `display change is stale`() {
        val before = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        ScreenGuard.publish(before)
        assertTrue(ScreenGuard.isStale(ScreenGuard.fingerprint("com.example", 2, false, false, listOf(sig("n1", "OK")))))
    }

    @Test
    fun `fingerprint is stable across calls and order sensitive`() {
        val a = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK"), sig("n2", "Cancel")))
        val b = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK"), sig("n2", "Cancel")))
        assertEquals(a, b)
        val swapped = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n2", "Cancel"), sig("n1", "OK")))
        assertNotEquals(a, swapped)
    }

    @Test
    fun `reset forgets the published snapshot`() {
        val fp = ScreenGuard.fingerprint("com.example", 0, false, false, listOf(sig("n1", "OK")))
        ScreenGuard.publish(fp)
        assertFalse(ScreenGuard.isStale(fp))
        ScreenGuard.reset()
        assertTrue(ScreenGuard.isStale(fp))
    }
}