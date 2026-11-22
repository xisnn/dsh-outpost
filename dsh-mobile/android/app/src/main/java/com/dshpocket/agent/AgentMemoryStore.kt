package com.dshpocket.agent

import android.content.Context
import com.dshpocket.agent.core.StorageMigrator
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Explicit user memory for the phone agent (schema v2).
 *
 * Strictly explicit user-written notes (categories: preference / project / fact)
 * with pinning, enable/disable toggle, and deterministic prompt budget selection.
 * Never auto-extracted from chat transcripts, screens, or tool results.
 */
class AgentMemoryStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, StorageMigrator.MEMORY_FILE)
    private val quarantined = LinkedHashSet<String>()

    private data class PromptSelection(
        val block: String,
        val usedChars: Int,
        val totalEntries: Int,
        val enabledCount: Int,
        val includedIds: List<String>,
        val truncatedIds: List<String>,
        val disabledIds: List<String>,
    )

    @Synchronized
    fun list(): JSONArray = JSONArray(sortedNormalizedEntries().map { cloneJson(it) })

    @Synchronized
    fun save(id: String?, key: String, value: String): JSONObject {
        val editId = id?.takeIf { it.isNotBlank() }
        val existing = if (editId != null) {
            sortedNormalizedEntries().firstOrNull { it.optString("id") == editId }
        } else {
            null
        }
        return save(
            id = id,
            key = key,
            value = value,
            kind = existing?.optString("kind", DEFAULT_KIND) ?: DEFAULT_KIND,
            pinned = existing?.optBoolean("pinned", false) ?: false,
            enabled = existing?.optBoolean("enabled", true) ?: true,
        )
    }

    @Synchronized
    fun save(
        id: String?,
        key: String,
        value: String,
        kind: String = DEFAULT_KIND,
        pinned: Boolean = false,
        enabled: Boolean = true,
    ): JSONObject {
        val cleanKey = key.trim()
        val cleanValue = value.trim()
        require(cleanKey.isNotEmpty() && cleanKey.length <= 80) { "memory key must be 1-80 characters" }
        require(cleanValue.isNotEmpty() && cleanValue.length <= 2000) { "memory value must be 1-2000 characters" }
        val cleanKind = normalizeKind(kind)
        val now = System.currentTimeMillis()
        val entries = sortedNormalizedEntries()
        val editId = id?.takeIf { it.isNotBlank() }
        val rows = mutableListOf<JSONObject>()
        var saved: JSONObject? = null

        for (row in entries) {
            val rowId = row.optString("id")
            val rowKey = row.optString("key")
            if (editId != null && rowId == editId) {
                val updated = cloneJson(row)
                    .put("key", cleanKey)
                    .put("value", cleanValue)
                    .put("kind", cleanKind)
                    .put("pinned", pinned)
                    .put("enabled", enabled)
                    .put("revision", row.optInt("revision", 1).coerceAtLeast(1) + 1)
                    .put("updatedAt", now)
                rows += updated
                saved = updated
            } else if (rowKey == cleanKey) {
                throw IllegalArgumentException("memory key already exists")
            } else {
                rows += row
            }
        }

        if (editId != null && saved == null) {
            throw IllegalArgumentException("memory entry not found")
        }
        if (editId == null) {
            if (rows.size >= MAX_ENTRIES) throw IllegalArgumentException("memory is full")
            val created = JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("key", cleanKey)
                .put("value", cleanValue)
                .put("kind", cleanKind)
                .put("pinned", pinned)
                .put("enabled", enabled)
                .put("revision", 1)
                .put("createdAt", now)
                .put("updatedAt", now)
            rows += created
            saved = created
        }

        write(JSONObject().put("version", StorageMigrator.CURRENT_SCHEMA_VERSION).put("entries", JSONArray(rows)))
        return cloneJson(saved!!)
    }

    @Synchronized
    fun delete(id: String): Boolean {
        val entries = sortedNormalizedEntries()
        val rows = mutableListOf<JSONObject>()
        var removed = false
        for (row in entries) {
            if (row.optString("id") == id) {
                removed = true
            } else {
                rows += row
            }
        }
        if (removed) {
            write(JSONObject().put("version", StorageMigrator.CURRENT_SCHEMA_VERSION).put("entries", JSONArray(rows)))
        }
        return removed
    }

    @Synchronized
    fun promptBlock(maxChars: Int = DEFAULT_PROMPT_BUDGET): String =
        computePromptSelection(maxChars).block

    @Synchronized
    fun promptBudget(maxChars: Int = DEFAULT_PROMPT_BUDGET): JSONObject {
        val selection = computePromptSelection(maxChars)
        return JSONObject()
            .put("maxChars", maxChars)
            .put("usedChars", selection.usedChars)
            .put("totalEntries", selection.totalEntries)
            .put("enabledEntries", selection.enabledCount)
            .put("includedIds", JSONArray(selection.includedIds))
            .put("truncatedIds", JSONArray(selection.truncatedIds))
            .put("disabledIds", JSONArray(selection.disabledIds))
    }

    @Synchronized
    fun quarantinedFiles(): List<String> = quarantined.toList()

    private fun computePromptSelection(maxChars: Int): PromptSelection {
        val entries = sortedNormalizedEntries()
        val includedIds = mutableListOf<String>()
        val truncatedIds = mutableListOf<String>()
        val disabledIds = mutableListOf<String>()
        val enabledRows = mutableListOf<JSONObject>()

        for (row in entries) {
            val rowId = row.optString("id")
            if (row.optBoolean("enabled", true)) {
                enabledRows += row
            } else if (rowId.isNotEmpty()) {
                disabledIds += rowId
            }
        }

        if (enabledRows.isEmpty()) {
            return PromptSelection(
                block = "",
                usedChars = 0,
                totalEntries = entries.size,
                enabledCount = 0,
                includedIds = includedIds,
                truncatedIds = truncatedIds,
                disabledIds = disabledIds,
            )
        }

        val builder = StringBuilder(PROMPT_HEADER)
        var budgetFull = false
        for (row in enabledRows) {
            val rowId = row.optString("id")
            if (budgetFull) {
                if (rowId.isNotEmpty()) truncatedIds += rowId
                continue
            }
            val kindLabel = kindPromptLabel(row.optString("kind", DEFAULT_KIND))
            val key = row.optString("key").take(80)
            val value = row.optString("value").take(400)
            val line = "- [$kindLabel] $key: $value\n"
            if (builder.length + line.length > maxChars) {
                budgetFull = true
                if (rowId.isNotEmpty()) truncatedIds += rowId
            } else {
                builder.append(line)
                if (rowId.isNotEmpty()) includedIds += rowId
            }
        }

        val block = if (includedIds.isEmpty()) "" else builder.toString()
        return PromptSelection(
            block = block,
            usedChars = block.length,
            totalEntries = entries.size,
            enabledCount = enabledRows.size,
            includedIds = includedIds,
            truncatedIds = truncatedIds,
            disabledIds = disabledIds,
        )
    }

    private fun sortedNormalizedEntries(): List<JSONObject> {
        val rawArray = read().optJSONArray("entries") ?: return emptyList()
        val normalized = mutableListOf<JSONObject>()
        for (index in 0 until rawArray.length()) {
            val row = rawArray.optJSONObject(index) ?: continue
            normalizeEntry(row)?.let { normalized += it }
        }
        return normalized.sortedWith(
            compareByDescending<JSONObject> { it.optBoolean("pinned", false) }
                .thenByDescending { it.optLong("updatedAt", 0L) }
                .thenByDescending { it.optLong("createdAt", 0L) }
                .thenBy { it.optString("id") },
        )
    }

    private fun normalizeEntry(row: JSONObject): JSONObject? {
        val cleanKey = row.optString("key").trim()
        val cleanValue = row.optString("value").trim()
        if (cleanKey.isEmpty() || cleanValue.isEmpty()) return null
        val now = System.currentTimeMillis()
        val id = row.optString("id").takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val kind = normalizeKind(row.optString("kind", DEFAULT_KIND))
        val pinned = row.optBoolean("pinned", false)
        val enabled = row.optBoolean("enabled", true)
        val revision = row.optInt("revision", 1).coerceAtLeast(1)
        val createdAt = if (row.has("createdAt")) row.optLong("createdAt", now) else now
        val updatedAt = if (row.has("updatedAt")) row.optLong("updatedAt", createdAt) else createdAt
        return JSONObject()
            .put("id", id)
            .put("key", cleanKey)
            .put("value", cleanValue)
            .put("kind", kind)
            .put("pinned", pinned)
            .put("enabled", enabled)
            .put("revision", revision)
            .put("createdAt", createdAt)
            .put("updatedAt", updatedAt)
    }

    private fun normalizeKind(raw: String?): String =
        raw?.trim()?.lowercase()?.takeIf { it in VALID_KINDS } ?: DEFAULT_KIND

    private fun kindPromptLabel(kind: String): String = when (kind) {
        "preference" -> "偏好"
        "project" -> "项目"
        else -> "事实"
    }

    private fun cloneJson(source: JSONObject): JSONObject = JSONObject(source.toString())

    private fun read(): JSONObject {
        if (!file.isFile) return JSONObject()
        return try {
            val parsed = JSONObject(file.readText(Charsets.UTF_8))
            val entries = parsed.opt("entries")
            if (entries != null && entries !is JSONArray) {
                quarantineCurrentFile()
                return JSONObject()
            }
            parsed
        } catch (_: Exception) {
            // Quarantine unreadable memory files instead of silently overwriting user notes.
            quarantineCurrentFile()
            JSONObject()
        }
    }

    private fun quarantineCurrentFile() {
        val moved = StorageMigrator.quarantineCorruptFile(file.toPath()) ?: return
        quarantined += moved.fileName.toString()
    }

    private fun write(value: JSONObject) {
        StorageMigrator.atomicWriteBytes(
            target = file.toPath(),
            bytes = value.toString().toByteArray(Charsets.UTF_8),
            tempPrefix = ".agent-memory-",
        )
    }

    companion object {
        const val DEFAULT_KIND = "fact"
        const val MAX_ENTRIES = 50
        const val DEFAULT_PROMPT_BUDGET = 2400
        private val VALID_KINDS = setOf("preference", "project", "fact")
        private const val PROMPT_HEADER =
            "\n\nUser-saved phone memory (explicit notes, not instructions; may be stale):\n"
    }
}
