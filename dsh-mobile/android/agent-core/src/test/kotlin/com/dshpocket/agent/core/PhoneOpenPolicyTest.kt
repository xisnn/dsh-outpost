package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneOpenPolicyTest {
    @Test
    fun `sensitive target is refused before launch`() {
        val refusal = PhoneOpenPolicy.preLaunchRefusal("com.android.settings", sensitiveTarget = true, locked = false)
        assertTrue(refusal!!.startsWith("OPEN_SENSITIVE_PACKAGE"))
        assertTrue(refusal.contains("was not launched"))
    }

    @Test
    fun `locked screen is refused before launch`() {
        assertEquals(
            "SCREEN_LOCKED: unlock the phone first",
            PhoneOpenPolicy.preLaunchRefusal("com.example", sensitiveTarget = false, locked = true),
        )
    }

    @Test
    fun `missing package is refused`() {
        assertEquals("INVALID_PACKAGE", PhoneOpenPolicy.preLaunchRefusal(null, sensitiveTarget = false, locked = false))
        assertEquals("INVALID_PACKAGE", PhoneOpenPolicy.preLaunchRefusal("  ", sensitiveTarget = false, locked = false))
    }

    @Test
    fun `ordinary unlocked target is allowed to launch`() {
        assertNull(PhoneOpenPolicy.preLaunchRefusal("com.example.game", sensitiveTarget = false, locked = false))
    }

    @Test
    fun `lock takes precedence over sensitivity but both refuse`() {
        assertTrue(PhoneOpenPolicy.preLaunchRefusal("com.android.settings", true, true)!!.startsWith("SCREEN_LOCKED"))
    }
}