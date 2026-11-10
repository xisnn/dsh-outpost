package com.dshpocket.agent.core

import java.security.MessageDigest

enum class RunPhase {
    QUEUED,
    PREPARING,
    RUNNING,
    WAITING_USER,
    STOPPING,
    COMPLETED,
    FAILED,
    INTERRUPTED,
}

data class RunSpec(
    val id: String,
    val goal: String,
    val maxSteps: Int = 24,
    /** Prior user/assistant turns for multi-turn runs; tool messages are not replayed. */
    val priorMessages: List<AgentMessage> = emptyList(),
)

data class RunSnapshot(
    val id: String,
    val phase: RunPhase,
    val step: Int = 0,
    val reason: String? = null,
    val requiresReconciliation: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis(),
    val goal: String? = null,
    val lastToolCallId: String? = null,
    val lastToolName: String? = null,
    val lastToolDigest: String? = null,
    val lastToolMayHaveSideEffect: Boolean = false,
    /** STARTED, OK, DENIED or ERROR. STARTED means the process died mid-tool. */
    val lastToolStatus: String? = null,
    val resultText: String? = null,
)

data class RunResult(
    val runId: String,
    val phase: RunPhase,
    val finalText: String?,
    val error: String?,
    val messages: List<AgentMessage>,
    val toolResults: List<ToolResult>,
)

sealed interface AgentMessage {
    data class System(val text: String) : AgentMessage
    data class User(val text: String) : AgentMessage
    data class Assistant(val text: String?, val calls: List<ToolCall> = emptyList()) : AgentMessage
    data class Tool(val callId: String, val name: String, val content: String) : AgentMessage
}

data class ToolSpec(
    val name: String,
    val description: String,
    val parameters: Map<String, Any?> = emptyMap(),
)

data class ToolCall(
    val id: String,
    val name: String,
    val arguments: Map<String, Any?> = emptyMap(),
)

enum class ToolRisk {
    READ,
    WRITE,
    PHONE,
    DANGEROUS,
}

enum class ToolStatus {
    OK,
    DENIED,
    ERROR,
}

data class ToolResult(
    val callId: String,
    val name: String,
    val status: ToolStatus,
    val content: String,
    val digest: String,
)

/** Deterministic canonical form for approval binding; not a general JSON encoder. */
fun canonical(value: Any?): String = when (value) {
    null -> "null"
    is String -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    is Number, is Boolean -> value.toString()
    is Map<*, *> -> value.entries
        .sortedBy { it.key.toString() }
        .joinToString(prefix = "{", postfix = "}") { canonical(it.key.toString()) + ":" + canonical(it.value) }
    is Iterable<*> -> value.joinToString(prefix = "[", postfix = "]") { canonical(it) }
    is Array<*> -> value.joinToString(prefix = "[", postfix = "]") { canonical(it) }
    else -> "\"" + value.toString().replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

fun digestArguments(arguments: Map<String, Any?>): String {
    val bytes = MessageDigest.getInstance("SHA-256").digest(canonical(arguments).toByteArray(Charsets.UTF_8))
    return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
