package com.dshpocket.agent.core

data class ModelRequest(
    val messages: List<AgentMessage>,
    val tools: List<ToolSpec>,
)

sealed interface ModelReply {
    data class Text(val text: String) : ModelReply
    data class Calls(val calls: List<ToolCall>, val text: String? = null) : ModelReply
    data class Failure(val code: String, val message: String) : ModelReply
}

/**
 * Provider-neutral model boundary. Adapters (OpenAI-compatible Chat Completions,
 * OpenAI Responses, Anthropic Messages, Gemini generateContent) normalize their
 * streaming/tool-call differences into [ModelReply].
 */
interface ModelClient {
    fun complete(request: ModelRequest): ModelReply

    /** P6-next #25: abort an in-flight request on stop; default no-op. */
    fun cancelInFlight() {}
}

/** Optional capability: providers that can stream text deltas while producing the final reply. */
interface StreamingModelClient : ModelClient {
    fun complete(request: ModelRequest, onText: (String) -> Unit): ModelReply
}
