package com.dshpocket.agent.core

/**
 * P4-0.3 #23: application-layer run deadline, pure JVM-testable.
 *
 * The foreground service enforces this on its notification tick so a run can
 * never exceed the app-layer limit even on OEM/API builds whose FGS dataSync
 * system cap is unknown (real-device API36 measurement remains on the
 * pending-real-device list). Service.onTimeout() uses the same graceful stop
 * path when the system reclaims the service first.
 *
 * Fail-closed direction: a non-positive limit (misconfiguration) or a clock
 * anomaly (now before start) STOPs the run; there is no unlimited mode.
 */
object RunDeadline {
    const val DEFAULT_LIMIT_MS = 30L * 60L * 1000L

    enum class Decision { CONTINUE, STOP }

    fun decision(startedAtMs: Long, nowMs: Long, limitMs: Long = DEFAULT_LIMIT_MS): Decision =
        when {
            limitMs <= 0 -> Decision.STOP
            nowMs < startedAtMs -> Decision.STOP
            nowMs - startedAtMs >= limitMs -> Decision.STOP
            else -> Decision.CONTINUE
        }
}
