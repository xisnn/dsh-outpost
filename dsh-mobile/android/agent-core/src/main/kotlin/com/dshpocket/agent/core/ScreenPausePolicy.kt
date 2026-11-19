package com.dshpocket.agent.core

/**
 * P4-0.3 #22: screen-off pause / unlock recovery decision, pure JVM-testable.
 *
 * Semantics:
 *  - SCREEN_OFF pauses an active run (recoverable) instead of stopping it,
 *    unless the user had explicitly paused (user pause is never overridden)
 *    or the run is already screen-off paused (idempotent).
 *  - USER_PRESENT (unlocked, not merely SCREEN_ON which can still be keyguard)
 *    resumes ONLY a screen-off pause; a user pause stays paused.
 *  - Inactive runs ignore both events.
 *
 * Security direction is unchanged: while paused, beforeStep blocks before any
 * model request or tool call; after resume, the existing locked-screen and
 * stale-screen guards still fail closed on unverified screens.
 */
object ScreenPausePolicy {
    enum class Action { PAUSE, RESUME, IGNORE }

    fun screenOff(active: Boolean, userPaused: Boolean, screenOffPaused: Boolean): Action =
        when {
            !active -> Action.IGNORE
            userPaused -> Action.IGNORE
            screenOffPaused -> Action.IGNORE
            else -> Action.PAUSE
        }

    fun userPresent(active: Boolean, screenOffPaused: Boolean): Action =
        if (active && screenOffPaused) Action.RESUME else Action.IGNORE
}
