package com.dshpocket.agent.core

/**
 * P6-next #15: sensitive-keyword matching without substring false positives.
 *
 * The old rule was `value.contains(keyword)`, so "shipping" matched "pin" and
 * ordinary screens were treated as sensitive. The new rule keeps the refusal
 * direction intact: Latin keywords match only at a TOKEN START (preceded by a
 * non-alphanumeric or string start), which kills mid-token hits (spin, shipping)
 * while still catching inflections (payments, passwords). CJK keywords keep
 * substring semantics because CJK text has no word boundaries; narrowing them
 * would relax fail-closed, which is forbidden.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI.
 */
object SensitiveWordMatch {
    fun matches(value: String, keyword: String): Boolean {
        if (keyword.isEmpty()) return false
        val v = value.lowercase()
        val k = keyword.lowercase()
        if (k.any { it.code > 0x7F }) return v.contains(k)
        var idx = v.indexOf(k)
        while (idx >= 0) {
            val before = if (idx == 0) ' ' else v[idx - 1]
            if (!before.isLetterOrDigit()) return true
            idx = v.indexOf(k, idx + 1)
        }
        return false
    }

    fun anySensitive(value: String, keywords: List<String>): Boolean =
        keywords.any { matches(value, it) }

    /**
     * Exact token match for short Latin keywords (e.g. "pay", "buy") so they
     * match "Pay", "Pay $9.99", or "Click to pay!" without matching "payload"
     * or "display". CJK keywords keep substring semantics.
     */
    fun matchesExactWord(value: String, keyword: String): Boolean {
        if (keyword.isEmpty()) return false
        val v = value.lowercase()
        val k = keyword.lowercase()
        if (k.any { it.code > 0x7F }) return v.contains(k)
        var idx = v.indexOf(k)
        while (idx >= 0) {
            val before = if (idx == 0) ' ' else v[idx - 1]
            val afterIdx = idx + k.length
            val after = if (afterIdx >= v.length) ' ' else v[afterIdx]
            if (!before.isLetterOrDigit() && !after.isLetterOrDigit()) return true
            idx = v.indexOf(k, idx + 1)
        }
        return false
    }
}
