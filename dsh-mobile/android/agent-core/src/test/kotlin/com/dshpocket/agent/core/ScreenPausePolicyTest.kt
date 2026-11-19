package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P4-0.3 #22 — screen-off pause / unlock recovery decision matrix.
 * User pauses are never overridden; recovery only applies to screen-off pauses.
 */
class ScreenPausePolicyTest {
    @Test
    fun `screen-off pauses an active run`() {
        assertEquals(
            ScreenPausePolicy.Action.PAUSE,
            ScreenPausePolicy.screenOff(active = true, userPaused = false, screenOffPaused = false),
        )
    }

    @Test
    fun `screen-off on inactive run ignores`() {
        assertEquals(
            ScreenPausePolicy.Action.IGNORE,
            ScreenPausePolicy.screenOff(active = false, userPaused = false, screenOffPaused = false),
        )
    }

    @Test
    fun `screen-off respects an explicit user pause`() {
        assertEquals(
            ScreenPausePolicy.Action.IGNORE,
            ScreenPausePolicy.screenOff(active = true, userPaused = true, screenOffPaused = false),
        )
    }

    @Test
    fun `double screen-off is idempotent`() {
        assertEquals(
            ScreenPausePolicy.Action.IGNORE,
            ScreenPausePolicy.screenOff(active = true, userPaused = false, screenOffPaused = true),
        )
    }

    @Test
    fun `user-present resumes a screen-off pause`() {
        assertEquals(
            ScreenPausePolicy.Action.RESUME,
            ScreenPausePolicy.userPresent(active = true, screenOffPaused = true),
        )
    }

    @Test
    fun `user-present never resumes a user pause or an inactive run`() {
        assertEquals(
            ScreenPausePolicy.Action.IGNORE,
            ScreenPausePolicy.userPresent(active = true, screenOffPaused = false),
        )
        assertEquals(
            ScreenPausePolicy.Action.IGNORE,
            ScreenPausePolicy.userPresent(active = false, screenOffPaused = true),
        )
    }
}
