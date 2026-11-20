package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P6-next #25: cancellation boundaries. Stop used to be purely cooperative (a
 * running tool finished first, an in-flight model request ran to completion).
 * The policy now distinguishes: abort the in-flight network call immediately,
 * abort a running tool loop at its next check, or stop between steps. Refusal
 * direction unchanged; this only makes cancellation timely, never weaker.
 */
class InterruptPolicyTest {
    @Test fun noStopContinuesRegardlessOfFlags() {
        assertEquals(InterruptPolicy.Action.CONTINUE, InterruptPolicy.decision(false, false, false))
        assertEquals(InterruptPolicy.Action.CONTINUE, InterruptPolicy.decision(false, true, true))
    }

    @Test fun stopWithNetworkInFlightAbortsImmediately() {
        assertEquals(InterruptPolicy.Action.ABORT_IN_FLIGHT, InterruptPolicy.decision(true, true, false))
    }

    @Test fun networkAbortWinsOverToolLoop() {
        assertEquals(InterruptPolicy.Action.ABORT_IN_FLIGHT, InterruptPolicy.decision(true, true, true))
    }

    @Test fun stopWithToolLoopAbortsAtNextCheck() {
        assertEquals(InterruptPolicy.Action.ABORT_AT_NEXT_CHECK, InterruptPolicy.decision(true, false, true))
    }

    @Test fun stopBetweenStepsWhenNothingInFlight() {
        assertEquals(InterruptPolicy.Action.STOP_BETWEEN_STEPS, InterruptPolicy.decision(true, false, false))
    }

    @Test fun inFlightAbortIsNeverContinue() {
        assertEquals(false, InterruptPolicy.decision(true, true, false) == InterruptPolicy.Action.CONTINUE)
    }
}
