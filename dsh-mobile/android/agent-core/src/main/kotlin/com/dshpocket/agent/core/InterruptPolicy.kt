package com.dshpocket.agent.core

/**
 * P6-next #25: cancellation boundary policy. Stop used to be purely cooperative:
 * a running tool finished first and an in-flight model request ran to completion,
 * so cancel latency was unbounded. The policy distinguishes aborting the
 * in-flight network call now, aborting a tool loop at its next check, and
 * stopping between steps. It only makes cancellation timelier; no security
 * direction is relaxed.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI.
 */
object InterruptPolicy {
    enum class Action { CONTINUE, ABORT_IN_FLIGHT, ABORT_AT_NEXT_CHECK, STOP_BETWEEN_STEPS }

    fun decision(stopRequested: Boolean, networkInFlight: Boolean, toolLoopRunning: Boolean): Action = when {
        !stopRequested -> Action.CONTINUE
        networkInFlight -> Action.ABORT_IN_FLIGHT
        toolLoopRunning -> Action.ABORT_AT_NEXT_CHECK
        else -> Action.STOP_BETWEEN_STEPS
    }
}
