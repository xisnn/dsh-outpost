package com.dshpocket.agent.core

import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Properties

interface RunStore {
    fun begin(spec: RunSpec)
    fun transition(runId: String, phase: RunPhase, reason: String? = null, requiresReconciliation: Boolean = false)
    fun step(runId: String, step: Int)
    fun toolAwaitingApproval(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    )

    fun toolStarted(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    )

    fun toolFinished(runId: String, callId: String, status: String)
    fun setResult(runId: String, text: String?)
    fun snapshot(runId: String): RunSnapshot?
    fun list(): List<RunSnapshot>
}

class MemoryRunStore : RunStore {
    private val runs = LinkedHashMap<String, RunSnapshot>()

    override fun begin(spec: RunSpec) {
        runs[spec.id] = RunSnapshot(spec.id, RunPhase.QUEUED, goal = spec.goal)
    }

    override fun transition(runId: String, phase: RunPhase, reason: String?, requiresReconciliation: Boolean) {
        val current = runs[runId] ?: RunSnapshot(runId, RunPhase.QUEUED)
        runs[runId] = current.copy(
            phase = phase,
            reason = reason,
            requiresReconciliation = requiresReconciliation,
            updatedAt = System.currentTimeMillis(),
        )
    }

    override fun step(runId: String, step: Int) {
        val current = runs[runId] ?: RunSnapshot(runId, RunPhase.QUEUED)
        runs[runId] = current.copy(step = step, updatedAt = System.currentTimeMillis())
    }

    override fun toolAwaitingApproval(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    ) {
        val current = runs[runId] ?: RunSnapshot(runId, RunPhase.QUEUED)
        runs[runId] = current.copy(
            lastToolCallId = callId,
            lastToolName = toolName,
            lastToolDigest = digest,
            lastToolMayHaveSideEffect = mayHaveSideEffect,
            lastToolStatus = "AWAITING_APPROVAL",
            updatedAt = System.currentTimeMillis(),
        )
    }

    override fun toolStarted(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    ) {
        val current = runs[runId] ?: RunSnapshot(runId, RunPhase.QUEUED)
        runs[runId] = current.copy(
            lastToolCallId = callId,
            lastToolName = toolName,
            lastToolDigest = digest,
            lastToolMayHaveSideEffect = mayHaveSideEffect,
            lastToolStatus = "STARTED",
            updatedAt = System.currentTimeMillis(),
        )
    }

    override fun toolFinished(runId: String, callId: String, status: String) {
        val current = runs[runId] ?: return
        if (current.lastToolCallId != callId) return
        runs[runId] = current.copy(lastToolStatus = status, updatedAt = System.currentTimeMillis())
    }

    override fun setResult(runId: String, text: String?) {
        val current = runs[runId] ?: return
        runs[runId] = current.copy(resultText = text, updatedAt = System.currentTimeMillis())
    }

    override fun snapshot(runId: String): RunSnapshot? = runs[runId]

    override fun list(): List<RunSnapshot> = runs.values.sortedBy { it.updatedAt }
}

/** Small crash-safe state file for one local run; full history/DB comes with the Android store. */
class FileRunStore(root: Path) : RunStore {
    private val directory = root.toAbsolutePath().normalize().also { Files.createDirectories(it) }

    @Synchronized
    override fun begin(spec: RunSpec) {
        write(RunSnapshot(spec.id, RunPhase.QUEUED, goal = spec.goal))
        prune()
    }

    /**
     * Run files otherwise accumulate for the life of the install. Pruning runs
     * once per run rather than once per write, since a write happens on every
     * step and every tool call.
     *
     * Only terminal runs are candidates, and never one still carrying
     * requiresReconciliation: that flag is the only evidence that a tool's side
     * effect is unknown, so it outlives the cap. Corrupt files report that flag
     * too and are therefore kept.
     */
    private fun prune() {
        val candidates = list().filter { it.phase in TERMINAL_PHASES && !it.requiresReconciliation }
        if (candidates.size <= MAX_RUN_FILES) return
        // list() is sorted ascending by updatedAt, so the overflow is the oldest.
        candidates.take(candidates.size - MAX_RUN_FILES).forEach { run ->
            runCatching { Files.deleteIfExists(fileFor(run.id)) }
        }
    }

    @Synchronized
    override fun transition(runId: String, phase: RunPhase, reason: String?, requiresReconciliation: Boolean) {
        val current = snapshot(runId) ?: RunSnapshot(runId, RunPhase.QUEUED)
        write(
            current.copy(
                phase = phase,
                reason = reason,
                requiresReconciliation = requiresReconciliation,
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    @Synchronized
    override fun step(runId: String, step: Int) {
        val current = snapshot(runId) ?: RunSnapshot(runId, RunPhase.QUEUED)
        write(current.copy(step = step, updatedAt = System.currentTimeMillis()))
    }

    @Synchronized
    override fun toolAwaitingApproval(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    ) {
        val current = snapshot(runId) ?: RunSnapshot(runId, RunPhase.QUEUED)
        write(
            current.copy(
                lastToolCallId = callId,
                lastToolName = toolName,
                lastToolDigest = digest,
                lastToolMayHaveSideEffect = mayHaveSideEffect,
                lastToolStatus = "AWAITING_APPROVAL",
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    @Synchronized
    override fun toolStarted(
        runId: String,
        callId: String,
        toolName: String,
        digest: String,
        mayHaveSideEffect: Boolean,
    ) {
        val current = snapshot(runId) ?: RunSnapshot(runId, RunPhase.QUEUED)
        write(
            current.copy(
                lastToolCallId = callId,
                lastToolName = toolName,
                lastToolDigest = digest,
                lastToolMayHaveSideEffect = mayHaveSideEffect,
                lastToolStatus = "STARTED",
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    @Synchronized
    override fun toolFinished(runId: String, callId: String, status: String) {
        val current = snapshot(runId) ?: return
        if (current.lastToolCallId != callId) return
        write(current.copy(lastToolStatus = status, updatedAt = System.currentTimeMillis()))
    }

    @Synchronized
    override fun setResult(runId: String, text: String?) {
        val current = snapshot(runId) ?: return
        write(current.copy(resultText = text, updatedAt = System.currentTimeMillis()))
    }

    @Synchronized
    override fun snapshot(runId: String): RunSnapshot? {
        val file = fileFor(runId)
        if (!Files.isRegularFile(file)) return null
        return try {
            val properties = Properties()
            FileInputStream(file.toFile()).use { properties.load(it) }
            // write() always records a phase, so a missing or unknown value means
            // the file is truncated or corrupt. Falling back to an active phase
            // would hand startup recovery a run it believes is resumable.
            val phase = parsePhase(properties.getProperty("phase")) ?: return corrupt(runId)
            RunSnapshot(
                id = properties.getProperty("id") ?: runId,
                phase = phase,
                step = (properties.getProperty("step") ?: "0").toIntOrNull() ?: 0,
                reason = properties.getProperty("reason"),
                requiresReconciliation = properties.getProperty("requiresReconciliation") == "true",
                updatedAt = (properties.getProperty("updatedAt") ?: "0").toLongOrNull() ?: 0L,
                goal = properties.getProperty("goal"),
                lastToolCallId = properties.getProperty("lastToolCallId"),
                lastToolName = properties.getProperty("lastToolName"),
                lastToolDigest = properties.getProperty("lastToolDigest"),
                lastToolMayHaveSideEffect = properties.getProperty("lastToolMayHaveSideEffect") == "true",
                lastToolStatus = properties.getProperty("lastToolStatus"),
                resultText = properties.getProperty("resultText"),
            )
        } catch (error: Exception) {
            corrupt(runId)
        }
    }

    /**
     * One unreadable state file must not take the whole store down with it:
     * [list] feeds [RunRecovery], so a single bad file would otherwise stop
     * every other run from being reconciled at startup. FAILED keeps the run
     * out of the active set, and requiresReconciliation surfaces it to the user
     * instead of hiding it.
     */
    private fun corrupt(runId: String): RunSnapshot = RunSnapshot(
        id = runId,
        phase = RunPhase.FAILED,
        reason = "run-state-unreadable",
        requiresReconciliation = true,
    )

    private fun parsePhase(raw: String?): RunPhase? =
        raw?.let { value -> RunPhase.values().firstOrNull { it.name == value } }

    @Synchronized
    override fun list(): List<RunSnapshot> {
        val files = Files.list(directory).use { stream ->
            stream.filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".properties") }
                .collect(java.util.stream.Collectors.toList())
        }
        return files.mapNotNull { file ->
            val name = file.fileName.toString().removeSuffix(".properties")
            // A stray or oddly named file in the directory is not a reason to
            // abandon recovery for the runs that are still readable.
            runCatching { snapshot(name) }.getOrNull()
        }.sortedBy { it.updatedAt }
    }

    private fun write(snapshot: RunSnapshot) {
        val properties = Properties().apply {
            setProperty("id", snapshot.id)
            setProperty("phase", snapshot.phase.name)
            setProperty("step", snapshot.step.toString())
            snapshot.reason?.let { setProperty("reason", it) }
            setProperty("requiresReconciliation", snapshot.requiresReconciliation.toString())
            setProperty("updatedAt", snapshot.updatedAt.toString())
            snapshot.goal?.let { setProperty("goal", it) }
            snapshot.lastToolCallId?.let { setProperty("lastToolCallId", it) }
            snapshot.lastToolName?.let { setProperty("lastToolName", it) }
            snapshot.lastToolDigest?.let { setProperty("lastToolDigest", it) }
            setProperty("lastToolMayHaveSideEffect", snapshot.lastToolMayHaveSideEffect.toString())
            snapshot.lastToolStatus?.let { setProperty("lastToolStatus", it) }
            snapshot.resultText?.let { setProperty("resultText", it) }
        }
        val target = fileFor(snapshot.id)
        val temporary = Files.createTempFile(directory, ".run-", ".tmp")
        try {
            FileOutputStream(temporary.toFile()).use { output ->
                properties.store(output, null)
                output.fd.sync()
            }
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun fileFor(runId: String): Path {
        require(runId.matches(Regex("[A-Za-z0-9._-]{1,100}"))) { "unsafe run id" }
        return directory.resolve("$runId.properties")
    }

    companion object {
        /** The run history screen only ever shows the most recent 30. */
        const val MAX_RUN_FILES = 60
        val TERMINAL_PHASES = setOf(RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.INTERRUPTED)
    }
}
