package com.dshpocket.agent.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.nio.file.Files
import java.nio.file.Path
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
    fun recordEvent(runId: String, event: RunEventRecord) {}
    fun acknowledgeReconciliation(runId: String, at: Long = System.currentTimeMillis()): Boolean = false
    fun snapshot(runId: String): RunSnapshot?
    fun list(): List<RunSnapshot>
}

internal fun sanitizeRunEventDetail(raw: String, maxLen: Int = 120): String {
    if (raw.isEmpty()) return ""
    val redacted = raw
        .replace(Regex("""\bsk-[A-Za-z0-9_-]{8,}"""), "[REDACTED]")
        .replace(Regex("""\bAIza[A-Za-z0-9_-]{8,}"""), "[REDACTED]")
        .replace(Regex("""(?i)\bBearer\s+[A-Za-z0-9._-]{8,}"""), "Bearer [REDACTED]")
        .replace(Regex("""(?i)\b(api[_-]?key|token|secret)\s*[:=]\s*\S+"""), "$1=[REDACTED]")
    return redacted.take(maxLen)
}

internal fun appendBoundedRunEvent(
    existing: List<RunEventRecord>,
    event: RunEventRecord,
    maxEvents: Int = FileRunStore.MAX_EVENTS,
): List<RunEventRecord> {
    val clean = event.copy(detail = sanitizeRunEventDetail(event.detail))
    val combined = existing + clean
    return if (combined.size <= maxEvents) combined else combined.takeLast(maxEvents)
}

class MemoryRunStore : RunStore {
    private val runs = LinkedHashMap<String, RunSnapshot>()

    override fun begin(spec: RunSpec) {
        val now = System.currentTimeMillis()
        runs[spec.id] = RunSnapshot(
            id = spec.id,
            phase = RunPhase.QUEUED,
            updatedAt = now,
            goal = spec.goal,
            createdAt = now,
        )
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

    override fun recordEvent(runId: String, event: RunEventRecord) {
        val current = runs[runId] ?: return
        runs[runId] = current.copy(
            events = appendBoundedRunEvent(current.events, event),
            updatedAt = maxOf(current.updatedAt, event.at),
        )
    }

    override fun acknowledgeReconciliation(runId: String, at: Long): Boolean {
        val current = runs[runId] ?: return false
        if (!current.requiresReconciliation && current.reconciledAt != null) return false
        runs[runId] = current.copy(requiresReconciliation = false, reconciledAt = at)
        return true
    }

    override fun snapshot(runId: String): RunSnapshot? = runs[runId]

    override fun list(): List<RunSnapshot> = runs.values.sortedBy { it.updatedAt }
}

/** Small crash-safe state file for one local run; full history/DB comes with the Android store. */
class FileRunStore(root: Path) : RunStore {
    private val directory = root.toAbsolutePath().normalize().also { Files.createDirectories(it) }

    @Synchronized
    override fun begin(spec: RunSpec) {
        val now = System.currentTimeMillis()
        write(
            RunSnapshot(
                id = spec.id,
                phase = RunPhase.QUEUED,
                updatedAt = now,
                goal = spec.goal,
                createdAt = now,
            ),
        )
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
    override fun recordEvent(runId: String, event: RunEventRecord) {
        val current = snapshot(runId) ?: return
        if (current.reason == "run-state-unreadable" && current.phase == RunPhase.FAILED && current.requiresReconciliation) {
            return
        }
        write(
            current.copy(
                events = appendBoundedRunEvent(current.events, event),
                updatedAt = maxOf(current.updatedAt, event.at),
            ),
        )
    }

    @Synchronized
    override fun acknowledgeReconciliation(runId: String, at: Long): Boolean {
        val file = runCatching { fileFor(runId) }.getOrNull() ?: return false
        if (!Files.isRegularFile(file)) return false
        val properties = Properties()
        val parsedPhase = runCatching {
            FileInputStream(file.toFile()).use { properties.load(it) }
            parsePhase(properties.getProperty("phase"))
        }.getOrNull()
        if (parsedPhase == null) {
            // Preserve unreadable run state evidence in quarantine instead of deleting it,
            // while unblocking active recovery lists and history pruning.
            return StorageMigrator.quarantineCorruptFile(file, at) != null
        }
        val current = snapshot(runId) ?: return false
        if (!current.requiresReconciliation && current.reconciledAt != null) return false
        write(
            current.copy(
                requiresReconciliation = false,
                reconciledAt = at,
            ),
        )
        return true
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
            val updatedAt = (properties.getProperty("updatedAt") ?: "0").toLongOrNull() ?: 0L
            val createdAt = properties.getProperty("createdAt")?.toLongOrNull() ?: updatedAt
            val reconciledAt = properties.getProperty("reconciledAt")?.toLongOrNull()
            val events = decodeEvents(properties.getProperty("eventsJson"))
            RunSnapshot(
                id = properties.getProperty("id") ?: runId,
                phase = phase,
                step = (properties.getProperty("step") ?: "0").toIntOrNull() ?: 0,
                reason = properties.getProperty("reason"),
                requiresReconciliation = properties.getProperty("requiresReconciliation") == "true",
                updatedAt = updatedAt,
                goal = properties.getProperty("goal"),
                lastToolCallId = properties.getProperty("lastToolCallId"),
                lastToolName = properties.getProperty("lastToolName"),
                lastToolDigest = properties.getProperty("lastToolDigest"),
                lastToolMayHaveSideEffect = properties.getProperty("lastToolMayHaveSideEffect") == "true",
                lastToolStatus = properties.getProperty("lastToolStatus"),
                resultText = properties.getProperty("resultText"),
                createdAt = createdAt,
                events = events,
                reconciledAt = reconciledAt,
            )
        } catch (error: Exception) {
            corrupt(runId)
        }
    }

    private fun decodeEvents(raw: String?): List<RunEventRecord> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = Json.parseToJsonElement(raw).jsonArray
            array.mapNotNull { elem ->
                val obj = elem as? JsonObject ?: return@mapNotNull null
                val seq = runCatching { obj["seq"]?.jsonPrimitive?.intOrNull }.getOrNull() ?: return@mapNotNull null
                val type = runCatching { obj["type"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: return@mapNotNull null
                val toolName = runCatching { obj["toolName"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                val status = runCatching { obj["status"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                val detail = runCatching { obj["detail"]?.jsonPrimitive?.contentOrNull }.getOrNull().orEmpty()
                val at = runCatching { obj["at"]?.jsonPrimitive?.longOrNull }.getOrNull() ?: 0L
                RunEventRecord(seq = seq, type = type, toolName = toolName, status = status, detail = detail, at = at)
            }.takeLast(MAX_EVENTS)
        }.getOrDefault(emptyList())
    }

    private fun encodeEvents(events: List<RunEventRecord>): String =
        buildJsonArray {
            for (event in events.takeLast(MAX_EVENTS)) {
                add(
                    buildJsonObject {
                        put("seq", JsonPrimitive(event.seq))
                        put("type", JsonPrimitive(event.type))
                        event.toolName?.let { put("toolName", JsonPrimitive(it)) }
                        event.status?.let { put("status", JsonPrimitive(it)) }
                        put("detail", JsonPrimitive(sanitizeRunEventDetail(event.detail)))
                        put("at", JsonPrimitive(event.at))
                    },
                )
            }
        }.toString()

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
            setProperty("schemaVersion", StorageMigrator.CURRENT_SCHEMA_VERSION.toString())
            setProperty("id", snapshot.id)
            setProperty("phase", snapshot.phase.name)
            setProperty("step", snapshot.step.toString())
            snapshot.reason?.let { setProperty("reason", it) }
            setProperty("requiresReconciliation", snapshot.requiresReconciliation.toString())
            setProperty("createdAt", snapshot.createdAt.toString())
            setProperty("updatedAt", snapshot.updatedAt.toString())
            snapshot.reconciledAt?.let { setProperty("reconciledAt", it.toString()) }
            if (snapshot.events.isNotEmpty()) {
                setProperty("eventsJson", encodeEvents(snapshot.events))
            }
            snapshot.goal?.let { setProperty("goal", it) }
            snapshot.lastToolCallId?.let { setProperty("lastToolCallId", it) }
            snapshot.lastToolName?.let { setProperty("lastToolName", it) }
            snapshot.lastToolDigest?.let { setProperty("lastToolDigest", it) }
            setProperty("lastToolMayHaveSideEffect", snapshot.lastToolMayHaveSideEffect.toString())
            snapshot.lastToolStatus?.let { setProperty("lastToolStatus", it) }
            snapshot.resultText?.let { setProperty("resultText", it) }
        }
        val target = fileFor(snapshot.id)
        val out = ByteArrayOutputStream()
        properties.store(out, null)
        StorageMigrator.atomicWriteBytes(target, out.toByteArray(), ".run-")
    }

    private fun fileFor(runId: String): Path {
        require(runId.matches(Regex("[A-Za-z0-9._-]{1,100}"))) { "unsafe run id" }
        return directory.resolve("$runId.properties")
    }

    companion object {
        /** The run history screen only ever shows the most recent 30. */
        const val MAX_RUN_FILES = 60
        const val MAX_EVENTS = 20
        val TERMINAL_PHASES = setOf(RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.INTERRUPTED)
    }
}
