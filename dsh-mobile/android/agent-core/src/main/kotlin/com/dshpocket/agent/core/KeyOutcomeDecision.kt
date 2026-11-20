package com.dshpocket.agent.core

/**
 * P6-next candidate 2: key-injection outcome three-state.
 *
 * A successful back/home can close the LAST app on a (virtual) display. "No
 * active window" afterwards is a legitimate empty display, not an injection
 * error; the old code reported ERROR and confused the model. Failed injection
 * is always ERROR even if a window happens to be present - success is never
 * claimed without an achieved injection.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI.
 */
object KeyOutcomeDecision {
    enum class Outcome { OK, OK_DISPLAY_EMPTY, ERROR }

    fun decision(injected: Boolean, windowPresent: Boolean): Outcome = when {
        !injected -> Outcome.ERROR
        !windowPresent -> Outcome.OK_DISPLAY_EMPTY
        else -> Outcome.OK
    }
}
