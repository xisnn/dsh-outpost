package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P6-next #17: native approval TTL, parity with butler local-approvals.js
 * (timeoutMs default 300000; now >= expiresAt => rejected). An approval that
 * outlives its TTL must never be applicable; missing/unverifiable issuedAt
 * fails closed. Refusal only.
 */
class ApprovalTtlTest {
    @Test fun withinTtlIsValid() {
        assertEquals(ApprovalTtl.Ttl.VALID, ApprovalTtl.decision(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS - 1))
    }

    @Test fun atTtlBoundaryIsExpired() {
        assertEquals(ApprovalTtl.Ttl.EXPIRED, ApprovalTtl.decision(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS))
    }

    @Test fun afterTtlIsExpired() {
        assertEquals(ApprovalTtl.Ttl.EXPIRED, ApprovalTtl.decision(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS + 5_000))
    }

    @Test fun missingIssuedAtIsUnverifiable() {
        assertEquals(ApprovalTtl.Ttl.UNVERIFIABLE, ApprovalTtl.decision(null, 2_000L))
        assertEquals(ApprovalTtl.Ttl.UNVERIFIABLE, ApprovalTtl.decision(0L, 2_000L))
    }

    @Test fun clockSkewIsUnverifiable() {
        assertEquals(ApprovalTtl.Ttl.UNVERIFIABLE, ApprovalTtl.decision(5_000L, 4_000L))
    }

    @Test fun nonPositiveTtlIsUnverifiable() {
        assertEquals(ApprovalTtl.Ttl.UNVERIFIABLE, ApprovalTtl.decision(1_000L, 2_000L, 0L))
    }

    @Test fun defaultTtlMatchesButlerTimeout() {
        assertEquals(300_000L, ApprovalTtl.DEFAULT_TTL_MS)
    }

    @Test fun remainingMsReturnsPositiveTimeLeftWithinTtl() {
        assertEquals(300_000L, ApprovalTtl.remainingMs(1_000L, 1_000L))
        assertEquals(120_000L, ApprovalTtl.remainingMs(1_000L, 181_000L))
        assertEquals(1L, ApprovalTtl.remainingMs(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS - 1))
    }

    @Test fun remainingMsReturnsZeroWhenExpiredOrUnverifiable() {
        assertEquals(0L, ApprovalTtl.remainingMs(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS))
        assertEquals(0L, ApprovalTtl.remainingMs(1_000L, 1_000L + ApprovalTtl.DEFAULT_TTL_MS + 5_000))
        assertEquals(0L, ApprovalTtl.remainingMs(null, 2_000L))
        assertEquals(0L, ApprovalTtl.remainingMs(5_000L, 4_000L))
    }
}
