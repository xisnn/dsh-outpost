package com.dshpocket.agent

import android.content.Context
import com.dshpocket.agent.core.AgentMessage
import com.dshpocket.agent.core.StorageMigrator
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class AgentThreadMessage(
    val role: String,
    val text: String,
    val at: Long,
)

/**
 * Multi-session local conversation store (schema v2).
 *
 * Each session holds user goals and assistant final answers; tool messages and
 * approval digests are intentionally not replayed into later model contexts.
 * Transparently reads legacy flat `agent-thread.json`, persists via fd.sync()
 * atomic swaps, and quarantines corrupt JSON files rather than silently wiping them.
 */
class AgentThreadStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, StorageMigrator.THREAD_FILE)
    private val quarantined = LinkedHashSet<String>()

    private data class SessionRecord(
        val id: String,
        var title: String,
        val createdAt: Long,
        var updatedAt: Long,
        val messages: MutableList<AgentThreadMessage>,
    )

    private data class ThreadState(
        var activeSessionId: String,
        val sessions: MutableList<SessionRecord>,
    )

    @Synchronized
    fun activeSessionId(): String = loadState().activeSessionId

    @Synchronized
    fun list(): List<AgentThreadMessage> {
        val state = loadState()
        return activeSession(state).messages.toList()
    }

    @Synchronized
    fun append(role: String, text: String) {
        appendToSession(null, role, text)
    }

    @Synchronized
    fun appendToSession(sessionId: String?, role: String, text: String) {
        if (role != "user" && role != "assistant") return
        val clean = text.trim()
        if (clean.isEmpty()) return
        val state = loadState()
        val target = sessionId?.let { sid -> state.sessions.firstOrNull { it.id == sid } }
            ?: activeSession(state)
        val now = System.currentTimeMillis()
        if (role == "user" && target.messages.isEmpty() && target.title == NEW_SESSION_TITLE) {
            val firstLine = clean.lineSequence().firstOrNull()?.trim().orEmpty()
            if (firstLine.isNotEmpty()) {
                target.title = firstLine.take(AUTO_TITLE_MAX_CHARS)
            }
        }
        target.messages += AgentThreadMessage(role, clean.take(12_000), now)
        trimMessages(target.messages)
        target.updatedAt = now
        saveState(state)
    }

    @Synchronized
    fun clear() {
        val state = loadState()
        val active = activeSession(state)
        active.messages.clear()
        active.updatedAt = System.currentTimeMillis()
        saveState(state)
    }

    @Synchronized
    fun priorMessages(): List<AgentMessage> = list().map {
        if (it.role == "user") AgentMessage.User(it.text) else AgentMessage.Assistant(it.text)
    }

    @Synchronized
    fun json(): JSONArray = JSONArray().apply {
        for (item in list()) {
            put(
                JSONObject()
                    .put("role", item.role)
                    .put("text", item.text)
                    .put("at", item.at),
            )
        }
    }

    @Synchronized
    fun sessionsStateJson(): JSONObject = buildSessionsStateJson(loadState())

    @Synchronized
    fun createSession(title: String? = null): JSONObject {
        val state = loadState()
        if (state.sessions.size >= MAX_SESSIONS) {
            throw IllegalArgumentException("SESSION_LIMIT_REACHED")
        }
        val cleanTitle = title?.trim()?.take(MAX_TITLE)?.ifEmpty { null } ?: NEW_SESSION_TITLE
        val now = System.currentTimeMillis()
        val created = SessionRecord(
            id = "s-" + UUID.randomUUID().toString().take(8),
            title = cleanTitle,
            createdAt = now,
            updatedAt = now,
            messages = mutableListOf(),
        )
        state.sessions += created
        state.activeSessionId = created.id
        saveState(state)
        return buildSessionsStateJson(state)
    }

    @Synchronized
    fun switchSession(sessionId: String): JSONObject {
        val state = loadState()
        if (state.sessions.none { it.id == sessionId }) {
            throw IllegalArgumentException("SESSION_NOT_FOUND")
        }
        state.activeSessionId = sessionId
        saveState(state)
        return buildSessionsStateJson(state)
    }

    @Synchronized
    fun renameSession(sessionId: String, title: String): JSONObject {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty() && cleanTitle.length <= MAX_TITLE) {
            "session title must be 1-$MAX_TITLE characters"
        }
        val state = loadState()
        val target = state.sessions.firstOrNull { it.id == sessionId }
            ?: throw IllegalArgumentException("SESSION_NOT_FOUND")
        target.title = cleanTitle
        saveState(state)
        return buildSessionsStateJson(state)
    }

    @Synchronized
    fun deleteSession(sessionId: String): JSONObject {
        val state = loadState()
        val removed = state.sessions.removeAll { it.id == sessionId }
        if (!removed) throw IllegalArgumentException("SESSION_NOT_FOUND")
        val now = System.currentTimeMillis()
        if (state.sessions.isEmpty()) {
            state.sessions += SessionRecord(
                id = DEFAULT_SESSION_ID,
                title = DEFAULT_SESSION_TITLE,
                createdAt = now,
                updatedAt = now,
                messages = mutableListOf(),
            )
            state.activeSessionId = DEFAULT_SESSION_ID
        } else if (state.activeSessionId == sessionId) {
            state.activeSessionId = state.sessions.maxByOrNull { it.updatedAt }!!.id
        }
        saveState(state)
        return buildSessionsStateJson(state)
    }

    @Synchronized
    fun quarantinedFiles(): List<String> = quarantined.toList()

    private fun buildSessionsStateJson(state: ThreadState): JSONObject {
        val ordered = state.sessions.sortedWith(
            compareByDescending<SessionRecord> { it.updatedAt }
                .thenByDescending { it.createdAt }
                .thenBy { it.id },
        )
        return JSONObject()
            .put("activeSessionId", state.activeSessionId)
            .put(
                "sessions",
                JSONArray().apply {
                    for (session in ordered) {
                        val preview = session.messages.lastOrNull()?.text
                            ?.replace('\n', ' ')
                            ?.trim()
                            ?.take(60)
                            .orEmpty()
                        put(
                            JSONObject()
                                .put("id", session.id)
                                .put("title", session.title)
                                .put("messageCount", session.messages.size)
                                .put("preview", preview)
                                .put("createdAt", session.createdAt)
                                .put("updatedAt", session.updatedAt),
                        )
                    }
                },
            )
    }

    private fun activeSession(state: ThreadState): SessionRecord =
        state.sessions.firstOrNull { it.id == state.activeSessionId } ?: state.sessions.first()

    private fun loadState(): ThreadState {
        val now = System.currentTimeMillis()
        val defaultOnly = {
            ThreadState(
                activeSessionId = DEFAULT_SESSION_ID,
                sessions = mutableListOf(
                    SessionRecord(DEFAULT_SESSION_ID, DEFAULT_SESSION_TITLE, now, now, mutableListOf()),
                ),
            )
        }
        if (!file.isFile) return defaultOnly()

        val root = try {
            JSONObject(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            quarantineCurrentFile()
            return defaultOnly()
        }

        val sessionsArray = root.optJSONArray("sessions")
        if (sessionsArray != null) {
            val sessions = mutableListOf<SessionRecord>()
            for (index in 0 until sessionsArray.length()) {
                val obj = sessionsArray.optJSONObject(index) ?: continue
                val id = obj.optString("id").takeIf { it.isNotBlank() } ?: continue
                val title = obj.optString("title").trim().ifEmpty { DEFAULT_SESSION_TITLE }.take(MAX_TITLE)
                val messages = parseMessages(obj.optJSONArray("messages"))
                trimMessages(messages)
                val createdAt = obj.optLong("createdAt", messages.firstOrNull()?.at ?: now)
                val updatedAt = obj.optLong("updatedAt", messages.lastOrNull()?.at ?: createdAt)
                sessions += SessionRecord(id, title, createdAt, updatedAt, messages)
            }
            if (sessions.isEmpty()) return defaultOnly()
            val activeId = root.optString("activeSessionId")
                .takeIf { candidate -> sessions.any { it.id == candidate } }
                ?: sessions.first().id
            return ThreadState(activeId, sessions)
        }

        val rawMessages = root.opt("messages")
        if (rawMessages != null && rawMessages !is JSONArray) {
            quarantineCurrentFile()
            return defaultOnly()
        }
        val messages = parseMessages(rawMessages as? JSONArray)
        trimMessages(messages)
        val createdAt = messages.firstOrNull()?.at ?: now
        val updatedAt = messages.lastOrNull()?.at ?: createdAt
        return ThreadState(
            activeSessionId = DEFAULT_SESSION_ID,
            sessions = mutableListOf(
                SessionRecord(DEFAULT_SESSION_ID, DEFAULT_SESSION_TITLE, createdAt, updatedAt, messages),
            ),
        )
    }

    private fun parseMessages(array: JSONArray?): MutableList<AgentThreadMessage> {
        val rows = mutableListOf<AgentThreadMessage>()
        if (array == null) return rows
        for (index in 0 until array.length()) {
            val row = array.optJSONObject(index) ?: continue
            val role = row.optString("role")
            val text = row.optString("text").trim()
            if ((role == "user" || role == "assistant") && text.isNotEmpty()) {
                rows += AgentThreadMessage(role, text, row.optLong("at"))
            }
        }
        return rows
    }

    private fun trimMessages(rows: MutableList<AgentThreadMessage>) {
        var total = rows.sumOf { it.text.length }
        while (rows.size > MAX_MESSAGES || total > MAX_CHARS) {
            val removed = rows.removeAt(0)
            total -= removed.text.length
        }
    }

    private fun quarantineCurrentFile() {
        val moved = StorageMigrator.quarantineCorruptFile(file.toPath()) ?: return
        quarantined += moved.fileName.toString()
    }

    private fun saveState(state: ThreadState) {
        val payload = JSONObject()
            .put("version", StorageMigrator.CURRENT_SCHEMA_VERSION)
            .put("activeSessionId", state.activeSessionId)
            .put(
                "sessions",
                JSONArray().apply {
                    for (session in state.sessions) {
                        put(
                            JSONObject()
                                .put("id", session.id)
                                .put("title", session.title)
                                .put("createdAt", session.createdAt)
                                .put("updatedAt", session.updatedAt)
                                .put(
                                    "messages",
                                    JSONArray().apply {
                                        for (item in session.messages) {
                                            put(
                                                JSONObject()
                                                    .put("role", item.role)
                                                    .put("text", item.text)
                                                    .put("at", item.at),
                                            )
                                        }
                                    },
                                ),
                        )
                    }
                },
            )
        StorageMigrator.atomicWriteBytes(
            target = file.toPath(),
            bytes = payload.toString().toByteArray(Charsets.UTF_8),
            tempPrefix = ".agent-thread-",
        )
    }

    private companion object {
        const val MAX_SESSIONS = 20
        const val MAX_MESSAGES = 40
        const val MAX_CHARS = 24_000
        const val MAX_TITLE = 40
        const val AUTO_TITLE_MAX_CHARS = 24
        const val DEFAULT_SESSION_ID = "default"
        const val DEFAULT_SESSION_TITLE = "默认对话"
        const val NEW_SESSION_TITLE = "新对话"
    }
}
