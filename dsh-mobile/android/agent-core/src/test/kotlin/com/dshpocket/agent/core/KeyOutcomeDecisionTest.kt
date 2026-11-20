package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * P6-next candidate 2: key injection outcome three-state. A successful back/home
 * can close the LAST app on a (virtual) display; "no active window" afterwards
 * is a legitimate empty display, not an injection error. The old code reported
 * it as ERROR, confusing the model. Failed injection is always ERROR, even if a
 * window happens to be present (never claim success we did not achieve).
 */
class KeyOutcomeDecisionTest {
    @Test fun injectedWithWindowIsOk() {
        assertEquals(KeyOutcomeDecision.Outcome.OK, KeyOutcomeDecision.decision(true, true))
    }

    @Test fun injectedWithEmptyDisplayIsOkDisplayEmpty() {
        assertEquals(KeyOutcomeDecision.Outcome.OK_DISPLAY_EMPTY, KeyOutcomeDecision.decision(true, false))
    }

    @Test fun failedInjectionWithWindowIsError() {
        assertEquals(KeyOutcomeDecision.Outcome.ERROR, KeyOutcomeDecision.decision(false, true))
    }

    @Test fun failedInjectionWithEmptyDisplayIsError() {
        assertEquals(KeyOutcomeDecision.Outcome.ERROR, KeyOutcomeDecision.decision(false, false))
    }

    @Test fun emptyDisplayAfterSuccessIsNotAnError() {
        assertNotEquals(KeyOutcomeDecision.Outcome.ERROR, KeyOutcomeDecision.decision(true, false))
    }
}
