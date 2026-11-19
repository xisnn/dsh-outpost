package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P4-0.3 #23 — application-layer run deadline. Fail-closed: misconfigured
 * (non-positive) limit and clock anomalies stop the run; no unlimited mode.
 */
class RunDeadlineTest {
    @Test
    fun `continue before the limit`() {
        assertEquals(
            RunDeadline.Decision.CONTINUE,
            RunDeadline.decision(startedAtMs = 1_000, nowMs = 1_000 + RunDeadline.DEFAULT_LIMIT_MS - 1),
        )
    }

    @Test
    fun `stop exactly at the limit`() {
        assertEquals(
            RunDeadline.Decision.STOP,
            RunDeadline.decision(startedAtMs = 1_000, nowMs = 1_000 + RunDeadline.DEFAULT_LIMIT_MS),
        )
    }

    @Test
    fun `stop after the limit`() {
        assertEquals(
            RunDeadline.Decision.STOP,
            RunDeadline.decision(startedAtMs = 1_000, nowMs = 1_000 + RunDeadline.DEFAULT_LIMIT_MS + 5_000),
        )
    }

    @Test
    fun `clock anomaly fails closed`() {
        assertEquals(
            RunDeadline.Decision.STOP,
            RunDeadline.decision(startedAtMs = 10_000, nowMs = 9_999),
        )
    }

    @Test
    fun `non-positive limit fails closed (no unlimited mode)`() {
        assertEquals(RunDeadline.Decision.STOP, RunDeadline.decision(1_000, 2_000, limitMs = 0))
        assertEquals(RunDeadline.Decision.STOP, RunDeadline.decision(1_000, 2_000, limitMs = -1))
    }
}
