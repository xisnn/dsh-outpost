package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * P4-0.3 #15 — word-boundary sensitive keyword matching.
 * RED against the extracted substring implementation: "shipping"/"pinned"/
 * "spin" must NOT trip on "pin". GREEN positives prove the fail-closed
 * direction is not relaxed (morphological variants still match).
 */
class SensitiveContentTest {
    @Test
    fun `negative - shipping does not trip on pin`() {
        assertNull(SensitiveContent.contentKeyword("shipping address"))
        assertNull(SensitiveContent.contentKeyword("Shipping"))
    }

    @Test
    fun `negative - pinned and spin do not trip on pin`() {
        assertNull(SensitiveContent.contentKeyword("pinned message"))
        assertNull(SensitiveContent.contentKeyword("spin the wheel"))
    }

    @Test
    fun `positive - bare pin and case variants still match`() {
        assertEquals("pin", SensitiveContent.contentKeyword("enter PIN"))
        assertEquals("pin", SensitiveContent.contentKeyword("pin:"))
    }

    @Test
    fun `positive - morphological variants are not relaxed`() {
        assertEquals("pin", SensitiveContent.contentKeyword("pincode"))
        assertEquals("password", SensitiveContent.contentKeyword("passwords"))
        assertEquals("passcode", SensitiveContent.contentKeyword("passcodes"))
        assertEquals("payment", SensitiveContent.contentKeyword("payments"))
        assertEquals("verification code", SensitiveContent.contentKeyword("verification codes"))
        assertEquals("bank card", SensitiveContent.contentKeyword("bank cards"))
    }

    @Test
    fun `positive - CJK keywords keep substring semantics`() {
        assertEquals("密码", SensitiveContent.contentKeyword("请输入密码"))
        assertEquals("验证码", SensitiveContent.contentKeyword("短信验证码已发送"))
        assertEquals("余额", SensitiveContent.contentKeyword("账户余额"))
    }

    @Test
    fun `positive - mixed CJK and latin boundaries`() {
        assertEquals("pin", SensitiveContent.contentKeyword("输入pin码"))
        assertEquals("password", SensitiveContent.contentKeyword("设置password后继续"))
    }

    @Test
    fun `negative - ordinary screen content stays non-sensitive`() {
        assertNull(SensitiveContent.contentKeyword("Search contacts"))
        assertNull(SensitiveContent.contentKeyword("Hello 测试 123"))
    }
}
