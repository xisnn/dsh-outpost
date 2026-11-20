package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P6-next #23: application-layer run deadline. The FGS dataSync system limit
 * (API36) is OEM-dependent and unverified on real devices, so the app imposes
 * its own bounded deadline and finishes gracefully instead of being killed
 * mid-tool. Missing/unverifiable start fails closed (stop), never "run forever".
 */
class RunDeadlineTest {
    @Test fun withinLimitIsWithin() {
        assertEquals(RunDeadline.Deadline.WITHIN, RunDeadline.decision(1_000L, 1_000L + RunDeadline.DEFAULT_LIMIT_MS - 1))
    }

    @Test fun atLimitIsExceeded() {
        assertEquals(RunDeadline.Deadline.EXCEEDED, RunDeadline.decision(1_000L, 1_000L + RunDeadline.DEFAULT_LIMIT_MS))
    }

    @Test fun afterLimitIsExceeded() {
        assertEquals(RunDeadline.Deadline.EXCEEDED, RunDeadline.decision(1_000L, 1_000L + RunDeadline.DEFAULT_LIMIT_MS + 1))
    }

    @Test fun missingStartIsUnverifiable() {
        assertEquals(RunDeadline.Deadline.UNVERIFIABLE, RunDeadline.decision(null, 2_000L))
        assertEquals(RunDeadline.Deadline.UNVERIFIABLE, RunDeadline.decision(0L, 2_000L))
    }

    @Test fun clockSkewIsUnverifiable() {
        assertEquals(RunDeadline.Deadline.UNVERIFIABLE, RunDeadline.decision(5_000L, 4_000L))
    }

    @Test fun nonPositiveLimitIsUnverifiable() {
        assertEquals(RunDeadline.Deadline.UNVERIFIABLE, RunDeadline.decision(1_000L, 2_000L, 0L))
    }
}
