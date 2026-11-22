package com.dshpocket.agent.core

/**
 * P6-next #23: application-layer run deadline.
 *
 * Android's dataSync foreground-service system limit (API36) is OEM-dependent
 * and not verified on real devices yet, so the app imposes its own bounded
 * deadline and finishes the run gracefully (stop + reconciliation state) rather
 * than being killed mid-tool by the system. Missing/unverifiable start fails
 * closed: an unbounded run is never allowed.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI; AgentService also
 * wires Service.onTimeout(startId, fgsType) (API34+) to the same graceful stop.
 */
object RunDeadline {
    /** Empirical app-layer cap; graceful stop, not a silent kill. */
    const val DEFAULT_LIMIT_MS = 30L * 60_000L

    enum class Deadline { WITHIN, EXCEEDED, UNVERIFIABLE }

    fun decision(startedAt: Long?, now: Long, limitMs: Long = DEFAULT_LIMIT_MS): Deadline {
        if (startedAt == null || startedAt <= 0 || limitMs <= 0) return Deadline.UNVERIFIABLE
        if (now < startedAt) return Deadline.UNVERIFIABLE
        return if (now - startedAt >= limitMs) Deadline.EXCEEDED else Deadline.WITHIN
    }

    fun remainingMs(startedAt: Long?, now: Long, limitMs: Long = DEFAULT_LIMIT_MS): Long {
        if (decision(startedAt, now, limitMs) != Deadline.WITHIN) return 0L
        return (startedAt!! + limitMs) - now
    }
}
