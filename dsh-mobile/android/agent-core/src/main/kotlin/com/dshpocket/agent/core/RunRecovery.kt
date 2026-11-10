package com.dshpocket.agent.core

/**
 * Startup-only reconciliation for runs left active by a previous process.
 *
 * A pending approval is intentionally not restored: the old call id and
 * argument digest are gone from memory, so nothing can be approved or replayed
 * after a process death. If the process died between toolStarted and
 * toolFinished, the tool's side effect is unknown; the run is marked
 * INTERRUPTED + requiresReconciliation and is never retried automatically.
 */
object RunRecovery {
    private val ACTIVE_PHASES = setOf(
        RunPhase.QUEUED,
        RunPhase.PREPARING,
        RunPhase.RUNNING,
        RunPhase.WAITING_USER,
        RunPhase.STOPPING,
    )

    fun recover(store: RunStore): RunSnapshot? {
        val recovered = mutableListOf<RunSnapshot>()
        for (run in store.list()) {
            if (run.phase !in ACTIVE_PHASES) continue
            val unknownTool = run.lastToolStatus == "STARTED" && run.lastToolMayHaveSideEffect
            val reason = when {
                unknownTool -> "process-interrupted: tool result unknown; old approval discarded; not replayed"
                run.lastToolStatus == "AWAITING_APPROVAL" -> "process-interrupted: pending approval discarded; not replayed"
                run.lastToolStatus == "STARTED" -> "process-interrupted: read-only tool was interrupted; not replayed"
                else -> "process-interrupted: run was not resumed"
            }
            // Recovery is all-or-nothing if it throws: one unwritable run file
            // would leave every other interrupted run looking active forever.
            // Reconcile what can be reconciled and leave the rest as found.
            val reconciled = runCatching {
                store.transition(
                    runId = run.id,
                    phase = RunPhase.INTERRUPTED,
                    reason = reason,
                    requiresReconciliation = unknownTool,
                )
                store.snapshot(run.id)
            }.getOrNull()
            reconciled?.let { recovered += it }
        }
        return recovered.maxByOrNull { it.updatedAt }
    }
}
