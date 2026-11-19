package com.dshpocket.agent.core

/**
 * P4-0.3 #15: sensitive screen-content keyword matching, extracted from
 * OutpostAccessibilityService as a pure JVM-testable function (same precedent
 * as ScreenGuard.staleDecision).
 *
 * Security direction is unchanged: matching only ever ADDS refusals
 * (fail-closed). The P4-0.3 change replaces naive substring matching for
 * Latin keywords with word-boundary matching (plus plural/compound tolerance)
 * so that e.g. "shipping" no longer trips on "pin", WITHOUT whitelisting or
 * disabling any keyword. CJK keywords keep substring semantics because
 * Chinese text has no word boundaries.
 */
object SensitiveContent {
    val KEYWORDS = listOf(
        "密码", "验证码", "支付", "付款", "转账", "银行卡", "余额", "安全码",
        "password", "passcode", "pin", "verification code", "payment", "bank card",
    )

    private val LATIN = Regex("^[a-z ]+$")

    private val MATCHERS: List<Pair<String, Regex?>> = KEYWORDS.map { keyword ->
        if (LATIN.matches(keyword)) {
            keyword to Regex(
                "(?<![a-z0-9])" + Regex.escape(keyword) + "(?:s|es|code)?(?![a-z0-9])",
            )
        } else {
            keyword to null
        }
    }

    /** Returns the matched keyword, or null when the value is not sensitive. */
    fun contentKeyword(value: String): String? {
        val v = value.lowercase()
        for ((keyword, boundary) in MATCHERS) {
            if (boundary == null) {
                if (v.contains(keyword)) return keyword
            } else if (boundary.containsMatchIn(v)) {
                return keyword
            }
        }
        return null
    }
}
