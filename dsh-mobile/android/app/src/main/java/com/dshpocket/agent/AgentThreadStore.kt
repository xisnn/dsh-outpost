package com.dshpocket.agent

import android.content.Context
import com.dshpocket.agent.core.AgentMessage
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

data class AgentThreadMessage(
    val role: String,
    val text: String,
    val at: Long,
)

/**
 * One local conversation thread across tasks. Only user goals and assistant
 * final answers are persisted; tool messages/approval digests are intentionally
 * not replayed into later model contexts. The queue itself is in-memory.
 */
class AgentThreadStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, "agent-thread.json")

    @Synchronized
    fun list(): List<AgentThreadMessage> {
        val root = read()
        val entries = root.optJSONArray("messages") ?: return emptyList()
        val rows = mutableListOf<AgentThreadMessage>()
        for (index in 0 until entries.length()) {
            val row = entries.optJSONObject(index) ?: continue
            val role = row.optString("role")
            val text = row.optString("text")
            if ((role == "user" || role == "assistant") && text.isNotBlank()) {
                rows += AgentThreadMessage(role, text, row.optLong("at"))
            }
        }
        return rows
    }

    @Synchronized
    fun append(role: String, text: String) {
        if (role != "user" && role != "assistant") return
        val clean = text.trim()
        if (clean.isEmpty()) return
        val rows = list().toMutableList()
        rows += AgentThreadMessage(role, clean.take(12000), System.currentTimeMillis())
        var total = rows.sumOf { it.text.length }
        while (rows.size > MAX_MESSAGES || total > MAX_CHARS) {
            val removed = rows.removeAt(0)
            total -= removed.text.length
        }
        write(rows)
    }

    @Synchronized
    fun clear() {
        write(emptyList())
    }

    fun priorMessages(): List<AgentMessage> = list().map {
        if (it.role == "user") AgentMessage.User(it.text) else AgentMessage.Assistant(it.text)
    }

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

    private fun read(): JSONObject {
        if (!file.isFile) return JSONObject()
        return try {
            JSONObject(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun write(rows: List<AgentThreadMessage>) {
        val value = JSONObject().put(
            "messages",
            JSONArray().apply {
                for (item in rows) {
                    put(
                        JSONObject()
                            .put("role", item.role)
                            .put("text", item.text)
                            .put("at", item.at),
                    )
                }
            },
        )
        val directory = file.parentFile ?: return
        Files.createDirectories(directory.toPath())
        val temporary = File.createTempFile(".agent-thread-", ".tmp", directory)
        try {
            temporary.writeText(value.toString(), Charsets.UTF_8)
            try {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            temporary.delete()
        }
    }

    private companion object {
        const val MAX_MESSAGES = 40
        const val MAX_CHARS = 24_000
    }
}
