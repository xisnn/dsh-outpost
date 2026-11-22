package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P6-next #15: sensitive-keyword matching must stop substring false positives
 * (shipping ⊃ pin) WITHOUT relaxing fail-closed. Latin keywords match only at a
 * token START (so payments/passwords still match, spin/shipping do not); CJK
 * keywords keep substring semantics because CJK has no word boundaries.
 * Refusal direction is never relaxed to silence a false positive.
 */
class SensitiveWordMatchTest {
    @Test fun latinSubstringInsideTokenDoesNotMatch() {
        assertEquals(false, SensitiveWordMatch.matches("shipping address", "pin"))
        assertEquals(false, SensitiveWordMatch.matches("spin class", "pin"))
    }

    @Test fun latinTokenStartMatches() {
        assertEquals(true, SensitiveWordMatch.matches("enter pin:", "pin"))
        assertEquals(true, SensitiveWordMatch.matches("pin code", "pin"))
        assertEquals(true, SensitiveWordMatch.matches("(pin) required", "pin"))
    }

    @Test fun latinPrefixOfLongerTokenStillMatches() {
        assertEquals(true, SensitiveWordMatch.matches("payments overview", "payment"))
        assertEquals(true, SensitiveWordMatch.matches("passwords list", "password"))
    }

    @Test fun matchingIsCaseInsensitive() {
        assertEquals(true, SensitiveWordMatch.matches("PIN CODE", "pin"))
        assertEquals(true, SensitiveWordMatch.matches("Payment Due", "payment"))
    }

    @Test fun cjkKeepsSubstringSemantics() {
        assertEquals(true, SensitiveWordMatch.matches("输入密码继续", "密码"))
        assertEquals(true, SensitiveWordMatch.matches("短信验证码", "验证码"))
    }

    @Test fun multiWordLatinKeywordMatchesAtTokenStart() {
        assertEquals(true, SensitiveWordMatch.matches("enter verification code now", "verification code"))
        assertEquals(false, SensitiveWordMatch.matches("xverification code", "verification code"))
    }

    @Test fun emptyValueOrKeywordNeverMatches() {
        assertEquals(false, SensitiveWordMatch.matches("", "pin"))
        assertEquals(false, SensitiveWordMatch.matches("pin", ""))
    }

    @Test fun anySensitiveScansTheWholeKeywordList() {
        val keywords = listOf("密码", "pin", "payment")
        assertEquals(true, SensitiveWordMatch.anySensitive("your pin here", keywords))
        assertEquals(false, SensitiveWordMatch.anySensitive("shipping address", keywords))
    }

    @Test fun exactWordMatchesStandaloneLatinPaymentVerbs() {
        assertEquals(true, SensitiveWordMatch.matchesExactWord("Pay", "pay"))
        assertEquals(true, SensitiveWordMatch.matchesExactWord("Pay $9.99", "pay"))
        assertEquals(true, SensitiveWordMatch.matchesExactWord("Click to pay!", "pay"))
        assertEquals(true, SensitiveWordMatch.matchesExactWord("Buy now", "buy"))
    }

    @Test fun exactWordRejectsSubstringsInsideLargerLatinWordsWhileKeepingCjkSubstring() {
        assertEquals(false, SensitiveWordMatch.matchesExactWord("Inspect payload", "pay"))
        assertEquals(false, SensitiveWordMatch.matchesExactWord("Repayment plan", "pay"))
        assertEquals(false, SensitiveWordMatch.matchesExactWord("Display", "pay"))
        assertEquals(false, SensitiveWordMatch.matchesExactWord("Buyers guide", "buy"))
        assertEquals(true, SensitiveWordMatch.matchesExactWord("立即支付订单", "支付"))
    }
}
