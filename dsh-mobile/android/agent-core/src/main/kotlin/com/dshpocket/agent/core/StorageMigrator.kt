package com.dshpocket.agent.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
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
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Properties
import java.util.UUID
import java.util.stream.Collectors

/**
 * Stop-the-world schema version manager & crash-safe migrator for agent local storage.
 *
 * Runs synchronously before [FileRunStore], [AgentMemoryStore], and [AgentThreadStore]
 * accept reads or writes:
 * - Fail-closed when on-disk `schemaVersion` > [CURRENT_SCHEMA_VERSION] (downgrade guard).
 * - Creates a pre-migration fsync snapshot backup under `agent-backups/` before mutating files.
 * - Upgrades v1 -> v2 losslessly and idempotently (re-entrant after mid-migration crash).
 * - Quarantines unparseable JSON files as `*.corrupt.<ts>` instead of silently overwriting user data.
 */
object StorageMigrator {
    const val CURRENT_SCHEMA_VERSION = 2
    const val MANIFEST_FILE = "storage-manifest.json"
    const val MEMORY_FILE = "agent-memory.json"
    const val THREAD_FILE = "agent-thread.json"
    const val RUNS_DIR = "agent-runs"
    const val BACKUPS_DIR = "agent-backups"
    const val MAX_BACKUPS = 3

    private val VALID_MEMORY_KINDS = setOf("preference", "project", "fact")

    enum class MigrationStatus {
        UP_TO_DATE,
        MIGRATED,
        DOWNGRADE_BLOCKED,
        FAILED,
    }

    data class MigrationReport(
        val status: MigrationStatus,
        val fromVersion: Int,
        val toVersion: Int,
        val migratedAt: Long,
        val backupPath: String? = null,
        val quarantinedFiles: List<String> = emptyList(),
        val warnings: List<String> = emptyList(),
        val error: String? = null,
    )

    fun atomicWriteBytes(target: Path, bytes: ByteArray, tempPrefix: String = ".tmp-") {
        val parent = target.toAbsolutePath().normalize().parent
            ?: throw IllegalArgumentException("target has no parent: $target")
        Files.createDirectories(parent)
        val temporary = Files.createTempFile(parent, tempPrefix, ".tmp")
        try {
            FileOutputStream(temporary.toFile()).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    fun quarantineCorruptFile(file: Path, now: Long = System.currentTimeMillis()): Path? {
        if (!Files.isRegularFile(file)) return null
        val parent = file.toAbsolutePath().normalize().parent ?: return null
        val baseName = file.fileName.toString()
        var candidate = parent.resolve("$baseName.corrupt.$now")
        var suffix = 1
        while (Files.exists(candidate)) {
            candidate = parent.resolve("$baseName.corrupt.$now.$suffix")
            suffix += 1
        }
        return try {
            try {
                Files.move(file, candidate, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(file, candidate, StandardCopyOption.REPLACE_EXISTING)
            }
            candidate
        } catch (_: Exception) {
            null
        }
    }

    @Synchronized
    fun migrateIfNeeded(rootDir: Path, now: Long = System.currentTimeMillis()): MigrationReport {
        val root = rootDir.toAbsolutePath().normalize()
        Files.createDirectories(root)

        val quarantined = mutableListOf<String>()
        val warnings = mutableListOf<String>()
        var storedVersion: Int? = null
        var storedMigratedAt = now
        var storedBackupPath: String? = null

        val manifestPath = root.resolve(MANIFEST_FILE)
        if (Files.isRegularFile(manifestPath)) {
            val parsedManifest = parseJsonObjectOrNull(manifestPath)
            val version = parsedManifest?.get("schemaVersion")?.let { elem ->
                runCatching { elem.jsonPrimitive.intOrNull }.getOrNull()
            }
            if (parsedManifest == null || version == null || version <= 0) {
                quarantineCorruptFile(manifestPath, now)?.let { moved ->
                    quarantined += root.relativize(moved).toString().replace('\\', '/')
                    warnings += "损坏的迁移清单已隔离保存，已重新校验存储结构。"
                }
            } else {
                storedVersion = version
                storedMigratedAt = parsedManifest["migratedAt"]?.let { elem ->
                    runCatching { elem.jsonPrimitive.longOrNull }.getOrNull()
                } ?: now
                storedBackupPath = parsedManifest["backupPath"]?.let { elem ->
                    runCatching { elem.jsonPrimitive.contentOrNull }.getOrNull()
                }
                if (version > CURRENT_SCHEMA_VERSION) {
                    return MigrationReport(
                        status = MigrationStatus.DOWNGRADE_BLOCKED,
                        fromVersion = version,
                        toVersion = CURRENT_SCHEMA_VERSION,
                        migratedAt = now,
                        backupPath = storedBackupPath,
                        quarantinedFiles = quarantined,
                        warnings = warnings,
                        error = "STORAGE_DOWNGRADE_BLOCKED: disk schema v$version is newer than app schema v$CURRENT_SCHEMA_VERSION",
                    )
                }
                if (version == CURRENT_SCHEMA_VERSION) {
                    return MigrationReport(
                        status = MigrationStatus.UP_TO_DATE,
                        fromVersion = CURRENT_SCHEMA_VERSION,
                        toVersion = CURRENT_SCHEMA_VERSION,
                        migratedAt = storedMigratedAt,
                        backupPath = storedBackupPath,
                        quarantinedFiles = quarantined,
                        warnings = warnings,
                    )
                }
            }
        }

        val memoryPath = root.resolve(MEMORY_FILE)
        val threadPath = root.resolve(THREAD_FILE)
        val runsPath = root.resolve(RUNS_DIR)
        val runFiles = if (Files.isDirectory(runsPath)) {
            Files.list(runsPath).use { stream ->
                stream.filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".properties") }
                    .collect(Collectors.toList())
            }
        } else {
            emptyList()
        }

        val hasExistingData = Files.isRegularFile(memoryPath) || Files.isRegularFile(threadPath) || runFiles.isNotEmpty()
        if (!hasExistingData && storedVersion == null) {
            writeManifest(
                manifestPath = manifestPath,
                schemaVersion = CURRENT_SCHEMA_VERSION,
                fromVersion = CURRENT_SCHEMA_VERSION,
                migratedAt = now,
                backupPath = null,
                quarantinedFiles = quarantined,
                warnings = warnings,
            )
            return MigrationReport(
                status = MigrationStatus.UP_TO_DATE,
                fromVersion = CURRENT_SCHEMA_VERSION,
                toVersion = CURRENT_SCHEMA_VERSION,
                migratedAt = now,
                quarantinedFiles = quarantined,
                warnings = warnings,
            )
        }

        val fromVersion = storedVersion ?: 1
        var backupRel: String? = null
        return try {
            // Step A: pre-migration fsync snapshot backup before modifying any file.
            val backupDir = createUniqueBackupDir(root.resolve(BACKUPS_DIR), "v$fromVersion-$now")
            backupRel = root.relativize(backupDir).toString().replace('\\', '/')
            if (Files.isRegularFile(memoryPath)) {
                atomicWriteBytes(backupDir.resolve(MEMORY_FILE), Files.readAllBytes(memoryPath), ".bak-mem-")
            }
            if (Files.isRegularFile(threadPath)) {
                atomicWriteBytes(backupDir.resolve(THREAD_FILE), Files.readAllBytes(threadPath), ".bak-thr-")
            }
            if (runFiles.isNotEmpty()) {
                val backupRuns = backupDir.resolve(RUNS_DIR)
                Files.createDirectories(backupRuns)
                for (runFile in runFiles) {
                    atomicWriteBytes(
                        backupRuns.resolve(runFile.fileName),
                        Files.readAllBytes(runFile),
                        ".bak-run-",
                    )
                }
            }
            pruneOldBackups(root.resolve(BACKUPS_DIR), MAX_BACKUPS)

            // Step B: upgrade agent-memory.json (v1 -> v2) or quarantine if corrupt.
            if (Files.isRegularFile(memoryPath)) {
                migrateMemoryFile(root, memoryPath, now, quarantined, warnings)
            }

            // Step C: upgrade agent-thread.json (flat -> multi-session v2) or quarantine if corrupt.
            if (Files.isRegularFile(threadPath)) {
                migrateThreadFile(root, threadPath, now, quarantined, warnings)
            }

            // Step D: stamp valid agent-runs/*.properties with schemaVersion & createdAt, leaving corrupt files intact.
            for (runFile in runFiles) {
                migrateRunFile(runFile, now)
            }

            // Step E: commit v2 manifest last so partial runs remain safely re-entrant.
            writeManifest(
                manifestPath = manifestPath,
                schemaVersion = CURRENT_SCHEMA_VERSION,
                fromVersion = fromVersion,
                migratedAt = now,
                backupPath = backupRel,
                quarantinedFiles = quarantined,
                warnings = warnings,
            )

            MigrationReport(
                status = MigrationStatus.MIGRATED,
                fromVersion = fromVersion,
                toVersion = CURRENT_SCHEMA_VERSION,
                migratedAt = now,
                backupPath = backupRel,
                quarantinedFiles = quarantined,
                warnings = warnings,
            )
        } catch (error: Exception) {
            MigrationReport(
                status = MigrationStatus.FAILED,
                fromVersion = fromVersion,
                toVersion = CURRENT_SCHEMA_VERSION,
                migratedAt = now,
                backupPath = backupRel,
                quarantinedFiles = quarantined,
                warnings = warnings,
                error = error.message ?: error.javaClass.simpleName,
            )
        }
    }

    private fun migrateMemoryFile(
        root: Path,
        memoryPath: Path,
        now: Long,
        quarantined: MutableList<String>,
        warnings: MutableList<String>,
    ) {
        val obj = parseJsonObjectOrNull(memoryPath)
        if (obj == null) {
            quarantineCorruptFile(memoryPath, now)?.let { moved ->
                quarantined += root.relativize(moved).toString().replace('\\', '/')
                warnings += "记忆存储文件损坏，已隔离保留副本 (${moved.fileName})。"
            }
            return
        }
        val rawEntries = when (val elem = obj["entries"]) {
            null -> emptyList<JsonElement>()
            is JsonArray -> elem.toList()
            else -> {
                quarantineCorruptFile(memoryPath, now)?.let { moved ->
                    quarantined += root.relativize(moved).toString().replace('\\', '/')
                    warnings += "记忆条目结构损坏，已隔离保留副本 (${moved.fileName})。"
                }
                return
            }
        }

        val dedupedByKey = LinkedHashMap<String, JsonObject>()
        var duplicateCount = 0
        for (item in rawEntries) {
            val row = item as? JsonObject ?: continue
            val key = stringOrNull(row, "key")?.trim().orEmpty()
            val value = stringOrNull(row, "value")?.trim().orEmpty()
            if (key.isEmpty() || value.isEmpty()) continue
            val id = stringOrNull(row, "id")?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
            val rawKind = stringOrNull(row, "kind")?.lowercase()
            val kind = if (rawKind in VALID_MEMORY_KINDS) rawKind!! else "fact"
            val pinned = boolOrNull(row, "pinned") ?: false
            val enabled = boolOrNull(row, "enabled") ?: true
            val revision = (intOrNull(row, "revision") ?: 1).coerceAtLeast(1)
            val createdAt = longOrNull(row, "createdAt") ?: now
            val updatedAt = longOrNull(row, "updatedAt") ?: createdAt
            val normalized = buildJsonObject {
                put("id", JsonPrimitive(id))
                put("key", JsonPrimitive(key))
                put("value", JsonPrimitive(value))
                put("kind", JsonPrimitive(kind))
                put("pinned", JsonPrimitive(pinned))
                put("enabled", JsonPrimitive(enabled))
                put("revision", JsonPrimitive(revision))
                put("createdAt", JsonPrimitive(createdAt))
                put("updatedAt", JsonPrimitive(updatedAt))
            }
            val existing = dedupedByKey[key]
            if (existing == null) {
                dedupedByKey[key] = normalized
            } else {
                duplicateCount += 1
                val existingUpdated = longOrNull(existing, "updatedAt") ?: 0L
                if (updatedAt >= existingUpdated) {
                    dedupedByKey[key] = normalized
                }
            }
        }
        if (duplicateCount > 0) {
            warnings += "记忆迁移时清理了 $duplicateCount 条重名记忆（已保留最新修改）。"
        }
        val upgraded = buildJsonObject {
            put("version", JsonPrimitive(CURRENT_SCHEMA_VERSION))
            put(
                "entries",
                buildJsonArray {
                    for (entry in dedupedByKey.values) add(entry)
                },
            )
        }
        atomicWriteBytes(memoryPath, upgraded.toString().toByteArray(Charsets.UTF_8), ".mig-mem-")
    }

    private fun migrateThreadFile(
        root: Path,
        threadPath: Path,
        now: Long,
        quarantined: MutableList<String>,
        warnings: MutableList<String>,
    ) {
        val obj = parseJsonObjectOrNull(threadPath)
        if (obj == null) {
            quarantineCorruptFile(threadPath, now)?.let { moved ->
                quarantined += root.relativize(moved).toString().replace('\\', '/')
                warnings += "对话记录文件损坏，已隔离保留副本 (${moved.fileName})。"
            }
            return
        }
        val existingVersion = intOrNull(obj, "version")
        val existingSessions = obj["sessions"] as? JsonArray
        if (existingVersion == CURRENT_SCHEMA_VERSION && existingSessions != null && existingSessions.isNotEmpty()) {
            val normalizedSessions = mutableListOf<JsonObject>()
            for (elem in existingSessions) {
                val sess = elem as? JsonObject ?: continue
                val sid = stringOrNull(sess, "id")?.takeIf { it.isNotBlank() } ?: continue
                val title = stringOrNull(sess, "title")?.trim()?.takeIf { it.isNotEmpty() } ?: "默认对话"
                val msgs = normalizeMessages(sess["messages"] as? JsonArray)
                val createdAt = longOrNull(sess, "createdAt") ?: msgs.firstOrNull()?.let { longOrNull(it, "at") } ?: now
                val updatedAt = longOrNull(sess, "updatedAt") ?: msgs.lastOrNull()?.let { longOrNull(it, "at") } ?: createdAt
                normalizedSessions += buildSessionObject(sid, title, createdAt, updatedAt, msgs)
            }
            if (normalizedSessions.isNotEmpty()) {
                val activeId = stringOrNull(obj, "activeSessionId")
                    ?.takeIf { candidate -> normalizedSessions.any { stringOrNull(it, "id") == candidate } }
                    ?: stringOrNull(normalizedSessions.first(), "id")!!
                val upgraded = buildJsonObject {
                    put("version", JsonPrimitive(CURRENT_SCHEMA_VERSION))
                    put("activeSessionId", JsonPrimitive(activeId))
                    put("sessions", buildJsonArray { normalizedSessions.forEach { add(it) } })
                }
                atomicWriteBytes(threadPath, upgraded.toString().toByteArray(Charsets.UTF_8), ".mig-thr-")
                return
            }
        }

        val rawMsgsElem = obj["messages"]
        if (rawMsgsElem != null && rawMsgsElem !is JsonArray) {
            quarantineCorruptFile(threadPath, now)?.let { moved ->
                quarantined += root.relativize(moved).toString().replace('\\', '/')
                warnings += "对话消息列表结构损坏，已隔离保留副本 (${moved.fileName})。"
            }
            return
        }
        val msgs = normalizeMessages(rawMsgsElem as? JsonArray)
        val firstAt = msgs.firstOrNull()?.let { longOrNull(it, "at") } ?: now
        val lastAt = msgs.lastOrNull()?.let { longOrNull(it, "at") } ?: firstAt
        val defaultSession = buildSessionObject("default", "默认对话", firstAt, lastAt, msgs)
        val upgraded = buildJsonObject {
            put("version", JsonPrimitive(CURRENT_SCHEMA_VERSION))
            put("activeSessionId", JsonPrimitive("default"))
            put("sessions", buildJsonArray { add(defaultSession) })
        }
        atomicWriteBytes(threadPath, upgraded.toString().toByteArray(Charsets.UTF_8), ".mig-thr-")
    }

    private fun normalizeMessages(array: JsonArray?): List<JsonObject> {
        if (array == null) return emptyList()
        val rows = mutableListOf<JsonObject>()
        for (elem in array) {
            val row = elem as? JsonObject ?: continue
            val role = stringOrNull(row, "role")
            val text = stringOrNull(row, "text")?.trim()
            if ((role == "user" || role == "assistant") && !text.isNullOrEmpty()) {
                val at = longOrNull(row, "at") ?: 0L
                rows += buildJsonObject {
                    put("role", JsonPrimitive(role))
                    put("text", JsonPrimitive(text))
                    put("at", JsonPrimitive(at))
                }
            }
        }
        return rows
    }

    private fun buildSessionObject(
        id: String,
        title: String,
        createdAt: Long,
        updatedAt: Long,
        messages: List<JsonObject>,
    ): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("title", JsonPrimitive(title))
        put("createdAt", JsonPrimitive(createdAt))
        put("updatedAt", JsonPrimitive(updatedAt))
        put("messages", buildJsonArray { messages.forEach { add(it) } })
    }

    private fun migrateRunFile(runFile: Path, now: Long) {
        val properties = Properties()
        val loaded = runCatching {
            FileInputStream(runFile.toFile()).use { properties.load(it) }
        }.isSuccess
        if (!loaded) return
        val phaseRaw = properties.getProperty("phase") ?: return
        val validPhase = RunPhase.values().any { it.name == phaseRaw }
        if (!validPhase) return // Leave unreadable/corrupt phase files untouched for FileRunStore isolation.
        var changed = false
        if (properties.getProperty("schemaVersion") != CURRENT_SCHEMA_VERSION.toString()) {
            properties.setProperty("schemaVersion", CURRENT_SCHEMA_VERSION.toString())
            changed = true
        }
        if (properties.getProperty("createdAt").isNullOrBlank()) {
            val fallbackCreated = properties.getProperty("updatedAt")?.takeIf { it.isNotBlank() } ?: now.toString()
            properties.setProperty("createdAt", fallbackCreated)
            changed = true
        }
        if (!changed) return
        val out = ByteArrayOutputStream()
        properties.store(out, null)
        atomicWriteBytes(runFile, out.toByteArray(), ".mig-run-")
    }

    private fun createUniqueBackupDir(backupsRoot: Path, baseName: String): Path {
        Files.createDirectories(backupsRoot)
        var candidate = backupsRoot.resolve(baseName)
        var suffix = 1
        while (Files.exists(candidate)) {
            candidate = backupsRoot.resolve("$baseName-$suffix")
            suffix += 1
        }
        Files.createDirectories(candidate)
        return candidate
    }

    private fun pruneOldBackups(backupsRoot: Path, keep: Int) {
        if (!Files.isDirectory(backupsRoot)) return
        val dirs = Files.list(backupsRoot).use { stream ->
            stream.filter { Files.isDirectory(it) }
                .collect(Collectors.toList())
        }.sortedBy { Files.getLastModifiedTime(it).toMillis() }
        if (dirs.size <= keep) return
        dirs.take(dirs.size - keep).forEach { dir ->
            runCatching { dir.toFile().deleteRecursively() }
        }
    }

    private fun writeManifest(
        manifestPath: Path,
        schemaVersion: Int,
        fromVersion: Int,
        migratedAt: Long,
        backupPath: String?,
        quarantinedFiles: List<String>,
        warnings: List<String>,
    ) {
        val payload = buildJsonObject {
            put("schemaVersion", JsonPrimitive(schemaVersion))
            put("fromVersion", JsonPrimitive(fromVersion))
            put("migratedAt", JsonPrimitive(migratedAt))
            if (backupPath != null) put("backupPath", JsonPrimitive(backupPath))
            if (quarantinedFiles.isNotEmpty()) {
                put("quarantinedFiles", buildJsonArray { quarantinedFiles.forEach { add(JsonPrimitive(it)) } })
            }
            if (warnings.isNotEmpty()) {
                put("warnings", buildJsonArray { warnings.forEach { add(JsonPrimitive(it)) } })
            }
        }
        atomicWriteBytes(manifestPath, payload.toString().toByteArray(Charsets.UTF_8), ".manifest-")
    }

    private fun parseJsonObjectOrNull(path: Path): JsonObject? = runCatching {
        val text = String(Files.readAllBytes(path), Charsets.UTF_8)
        Json.parseToJsonElement(text).jsonObject
    }.getOrNull()

    private fun stringOrNull(obj: JsonObject, key: String): String? =
        runCatching { obj[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

    private fun intOrNull(obj: JsonObject, key: String): Int? =
        runCatching { obj[key]?.jsonPrimitive?.intOrNull }.getOrNull()

    private fun longOrNull(obj: JsonObject, key: String): Long? =
        runCatching { obj[key]?.jsonPrimitive?.longOrNull }.getOrNull()

    private fun boolOrNull(obj: JsonObject, key: String): Boolean? =
        runCatching { obj[key]?.jsonPrimitive?.booleanOrNull }.getOrNull()
}
