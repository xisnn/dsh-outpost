package com.dshpocket.agent.core

/**
 * P6-next #17: native approval time-to-live, parity with the butler host
 * (dsh-outpost-butler/lib/local-approvals.js: timeoutMs default 300000 and
 * `now >= expiresAt` finishes the approval rejected).
 *
 * An approval the user never answered must not stay applicable forever, and a
 * decision arriving after expiry must never be applied. Missing or unverifiable
 * issuedAt (null/<=0, clock skew, non-positive ttl) fails closed. Refusal only.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI.
 */
object ApprovalTtl {
    /** Same default as butler local-approvals timeoutMs. */
    const val DEFAULT_TTL_MS = 300_000L

    enum class Ttl { VALID, EXPIRED, UNVERIFIABLE }

    fun decision(issuedAt: Long?, now: Long, ttlMs: Long = DEFAULT_TTL_MS): Ttl {
        if (issuedAt == null || issuedAt <= 0 || ttlMs <= 0) return Ttl.UNVERIFIABLE
        if (now < issuedAt) return Ttl.UNVERIFIABLE
        return if (now - issuedAt >= ttlMs) Ttl.EXPIRED else Ttl.VALID
    }
}
