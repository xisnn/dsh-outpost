package com.dshpocket.agent.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URI

enum class ModelProtocol {
    OPENAI_COMPAT,
    OPENAI_RESPONSES,
    ANTHROPIC,
    GEMINI,
    ;

    companion object {
        fun fromWire(value: String?): ModelProtocol? = entries.firstOrNull {
            it.name.equals(value?.trim(), ignoreCase = true)
        }
    }
}

data class ModelConfig(
    val protocol: ModelProtocol,
    val baseUrl: String,
    val model: String,
    val apiKey: String,
    val maxOutputTokens: Int = 2048,
) {
    companion object {
        fun defaultBaseUrl(protocol: ModelProtocol): String = when (protocol) {
            ModelProtocol.OPENAI_COMPAT -> "https://api.deepseek.com/v1"
            ModelProtocol.OPENAI_RESPONSES -> "https://api.openai.com/v1"
            ModelProtocol.ANTHROPIC -> "https://api.anthropic.com"
            ModelProtocol.GEMINI -> "https://generativelanguage.googleapis.com"
        }
    }
}

/**
 * Provider adapters normalize four common cloud protocols into [ModelReply].
 * There is no cross-provider fallback: one run uses exactly one configured
 * provider/model, and any protocol or transport problem is a visible failure.
 *
 * P6-1 deliberately parses the complete SSE body before returning. The loop is
 * synchronous today; incremental UI streaming can be added later without
 * changing the provider-neutral reply contract.
 */
class CloudModelClient(
    private val config: ModelConfig,
    private val transport: HttpTransport = UrlConnectionTransport(),
) : StreamingModelClient {
    override fun complete(request: ModelRequest): ModelReply = complete(request) { }

    override fun complete(request: ModelRequest, onText: (String) -> Unit): ModelReply {
        if (config.apiKey.isBlank()) return ModelReply.Failure("missing-key", "cloud model API key is not configured")
        if (config.model.isBlank()) return ModelReply.Failure("missing-model", "cloud model name is not configured")
        if (!config.baseUrl.startsWith("https://") && !config.baseUrl.startsWith("http://")) {
            return ModelReply.Failure("invalid-base-url", "base URL must start with https:// or http://")
        }
        if (!modelBaseUrlAllowed(config.baseUrl)) {
            return ModelReply.Failure(
                "insecure-base-url",
                "cloud model base URL must use HTTPS; plain HTTP is allowed only for loopback/local testing",
            )
        }
        val reply = try {
            when (config.protocol) {
                ModelProtocol.OPENAI_COMPAT -> openAiCompatible(request, onText)
                ModelProtocol.OPENAI_RESPONSES -> openAiResponses(request, onText)
                ModelProtocol.ANTHROPIC -> anthropic(request, onText)
                ModelProtocol.GEMINI -> gemini(request, onText)
            }
        } catch (error: Exception) {
            ModelReply.Failure("model-transport", error.message?.take(500) ?: error.javaClass.simpleName)
        }
        return if (reply is ModelReply.Failure) reply.copy(message = redact(reply.message)) else reply
    }

    private fun redact(value: String): String =
        if (config.apiKey.isBlank()) value else value.replace(config.apiKey, "[redacted]")

    private fun openAiCompatible(request: ModelRequest, onText: (String) -> Unit): ModelReply {
        val body = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("max_tokens", config.maxOutputTokens)
            put("messages", openAiMessages(request.messages))
            if (request.tools.isNotEmpty()) {
                put("tools", openAiTools(request.tools))
                put("tool_choice", "auto")
            }
        }.toString()
        val response = transport.stream(
            HttpRequest(
                url = endpoint(config.baseUrl, "/chat/completions"),
                headers = bearerHeaders(),
                body = body,
            ),
        ) { event -> openAiTextDelta(event)?.let(onText) }
        httpFailure(response)?.let { return it }
        return parseOpenAiResponse(response.body)
    }

    private fun openAiResponses(request: ModelRequest, onText: (String) -> Unit): ModelReply {
        val system = request.messages.filterIsInstance<AgentMessage.System>()
            .joinToString("\n\n") { it.text }
            .takeIf { it.isNotBlank() }
        val body = buildJsonObject {
            put("model", config.model)
            put("max_output_tokens", config.maxOutputTokens)
            if (system != null) put("instructions", system)
            put("input", responsesInput(request.messages))
            if (request.tools.isNotEmpty()) put("tools", responsesTools(request.tools))
        }.toString()
        val response = transport.post(
            HttpRequest(
                url = endpoint(config.baseUrl, "/responses"),
                headers = bearerHeaders(),
                body = body,
            ),
        )
        httpFailure(response)?.let { return it }
        val reply = parseResponsesResponse(response.body)
        if (reply is ModelReply.Text) onText(reply.text)
        if (reply is ModelReply.Calls && !reply.text.isNullOrBlank()) onText(reply.text)
        return reply
    }

    private fun anthropic(request: ModelRequest, onText: (String) -> Unit): ModelReply {
        val system = request.messages.filterIsInstance<AgentMessage.System>()
            .joinToString("\n\n") { it.text }
            .takeIf { it.isNotBlank() }
        val body = buildJsonObject {
            put("model", config.model)
            put("max_tokens", config.maxOutputTokens)
            put("stream", true)
            if (system != null) put("system", system)
            put("messages", anthropicMessages(request.messages))
            if (request.tools.isNotEmpty()) put("tools", anthropicTools(request.tools))
        }.toString()
        val response = transport.stream(
            HttpRequest(
                url = anthropicEndpoint(config.baseUrl),
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "x-api-key" to config.apiKey,
                    "anthropic-version" to "2023-06-01",
                ),
                body = body,
            ),
        ) { event -> anthropicTextDelta(event)?.let(onText) }
        httpFailure(response)?.let { return it }
        return parseAnthropicResponse(response.body)
    }

    private fun gemini(request: ModelRequest, onText: (String) -> Unit): ModelReply {
        val model = config.model.removePrefix("models/").trim()
        if (!model.matches(Regex("[A-Za-z0-9._-]+"))) {
            return ModelReply.Failure("invalid-model", "Gemini model name contains unsupported characters")
        }
        val system = request.messages.filterIsInstance<AgentMessage.System>()
            .joinToString("\n\n") { it.text }
            .takeIf { it.isNotBlank() }
        val body = buildJsonObject {
            if (system != null) {
                put(
                    "systemInstruction",
                    buildJsonObject {
                        put("parts", buildJsonArray { add(buildJsonObject { put("text", system) }) })
                    },
                )
            }
            put("contents", geminiContents(request.messages))
            if (request.tools.isNotEmpty()) {
                put(
                    "tools",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("functionDeclarations", geminiTools(request.tools))
                            },
                        )
                    },
                )
            }
            put("generationConfig", buildJsonObject { put("maxOutputTokens", config.maxOutputTokens) })
        }.toString()
        val response = transport.stream(
            HttpRequest(
                url = geminiEndpoint(config.baseUrl, model),
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "x-goog-api-key" to config.apiKey,
                ),
                body = body,
            ),
        ) { event -> geminiTextDelta(event)?.let(onText) }
        httpFailure(response)?.let { return it }
        return parseGeminiResponse(response.body)
    }

    private fun bearerHeaders(): Map<String, String> = mapOf(
        "Content-Type" to "application/json",
        "Authorization" to "Bearer ${config.apiKey}",
    )

    private fun httpFailure(response: HttpResponse): ModelReply? {
        if (response.status in 200..299) return null
        val detail = redact(response.body).replace(Regex("\\s+"), " ").trim().take(600)
        return ModelReply.Failure(
            "http-${response.status}",
            detail.ifBlank { "provider returned HTTP ${response.status}" },
        )
    }
}

private fun endpoint(baseUrl: String, suffix: String): String {
    val base = baseUrl.trim().trimEnd('/')
    return if (base.endsWith(suffix)) base else base + suffix
}

private fun anthropicEndpoint(baseUrl: String): String {
    val base = baseUrl.trim().trimEnd('/')
    return when {
        base.endsWith("/messages") -> base
        base.endsWith("/v1") -> "$base/messages"
        else -> "$base/v1/messages"
    }
}

private fun geminiEndpoint(baseUrl: String, model: String): String {
    val base = baseUrl.trim().trimEnd('/')
    val root = if (base.endsWith("/v1beta")) base else "$base/v1beta"
    return "$root/models/$model:streamGenerateContent?alt=sse"
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

private fun openAiMessages(messages: List<AgentMessage>): JsonArray = buildJsonArray {
    for (message in messages) {
        when (message) {
            is AgentMessage.System -> add(
                buildJsonObject {
                    put("role", "system")
                    put("content", message.text)
                },
            )

            is AgentMessage.User -> add(
                buildJsonObject {
                    put("role", "user")
                    put("content", message.text)
                },
            )

            is AgentMessage.Assistant -> add(
                buildJsonObject {
                    put("role", "assistant")
                    if (message.text.isNullOrEmpty()) put("content", JsonNull) else put("content", message.text)
                    if (message.calls.isNotEmpty()) {
                        put(
                            "tool_calls",
                            buildJsonArray {
                                for (call in message.calls) {
                                    add(
                                        buildJsonObject {
                                            put("id", call.id)
                                            put("type", "function")
                                            put(
                                                "function",
                                                buildJsonObject {
                                                    put("name", call.name)
                                                    put("arguments", call.arguments.toJsonElement().toString())
                                                },
                                            )
                                        },
                                    )
                                }
                            },
                        )
                    }
                },
            )

            is AgentMessage.Tool -> add(
                buildJsonObject {
                    put("role", "tool")
                    put("tool_call_id", message.callId)
                    put("content", message.content)
                },
            )
        }
    }
}

private fun openAiTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
    for (tool in tools) {
        add(
            buildJsonObject {
                put("type", "function")
                put(
                    "function",
                    buildJsonObject {
                        put("name", tool.name)
                        put("description", tool.description)
                        put("parameters", tool.parameters.toJsonElement())
                    },
                )
            },
        )
    }
}

private fun openAiTextDelta(event: SseEvent): String? {
    val data = event.data.trim()
    if (data == "[DONE]") return null
    val root = parseObject(data) ?: return null
    val choice = (root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return null
    val delta = choice["delta"] as? JsonObject ?: return null
    return delta["content"].textContent()
}

private fun anthropicTextDelta(event: SseEvent): String? {
    val root = parseObject(event.data) ?: return null
    val type = event.event ?: root.string("type")
    if (type != "content_block_delta") return null
    val delta = root["delta"] as? JsonObject ?: return null
    if (delta.string("type") != "text_delta") return null
    return delta.string("text")
}

private fun geminiTextDelta(event: SseEvent): String? {
    val root = parseObject(event.data) ?: return null
    val candidates = root["candidates"] as? JsonArray ?: return null
    val builder = StringBuilder()
    for (candidateElement in candidates) {
        val candidate = candidateElement as? JsonObject ?: continue
        val content = candidate["content"] as? JsonObject ?: continue
        val parts = content["parts"] as? JsonArray ?: continue
        for (partElement in parts) {
            val part = partElement as? JsonObject ?: continue
            if ((part["thought"] as? JsonPrimitive)?.booleanOrNull == true) continue
            part.string("text")?.let { builder.append(it) }
        }
    }
    return builder.toString().ifEmpty { null }
}

private class OpenAiToolCall {
    var id: String? = null
    var name: String? = null
    val arguments = StringBuilder()
}

private fun parseOpenAiResponse(body: String): ModelReply {
    val events = parseSse(body)
    if (events.isEmpty()) {
        val objectValue = parseObject(body)
        return if (objectValue != null) parseOpenAiMessageObject(objectValue) else {
            ModelReply.Failure("empty-reply", "provider returned no SSE events")
        }
    }
    val text = StringBuilder()
    val calls = linkedMapOf<Int, OpenAiToolCall>()
    for (event in events) {
        val data = event.data.trim()
        if (data == "[DONE]") continue
        if (event.event == "error") return ModelReply.Failure("provider-error", providerMessage(data))
        val root = parseObject(data) ?: return ModelReply.Failure("protocol-error", "invalid SSE JSON from provider")
        providerError(root)?.let { return it }
        val choice = (root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: continue
        val delta = choice["delta"] as? JsonObject
        delta?.get("content")?.textContent()?.let { text.append(it) }
        val toolCalls = delta?.get("tool_calls") as? JsonArray ?: continue
        for ((position, element) in toolCalls.withIndex()) {
            val item = element as? JsonObject ?: continue
            val index = item.int("index") ?: position
            val call = calls.getOrPut(index) { OpenAiToolCall() }
            item.string("id")?.takeIf { it.isNotBlank() }?.let { call.id = it }
            val function = item["function"] as? JsonObject
            function?.string("name")?.takeIf { it.isNotBlank() }?.let { call.name = it }
            function?.string("arguments")?.let { call.arguments.append(it) }
        }
    }
    return toolCallsReply(text.toString(), calls.mapValues { it.value.toToolCallOrNull() })
}

private fun parseOpenAiMessageObject(root: JsonObject): ModelReply {
    providerError(root)?.let { return it }
    val message = ((root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject)
        ?.get("message") as? JsonObject ?: return ModelReply.Failure("protocol-error", "missing choices[0].message")
    val text = message["content"].textContent().orEmpty()
    val calls = linkedMapOf<Int, OpenAiToolCall>()
    val toolCalls = message["tool_calls"] as? JsonArray ?: JsonArray(emptyList())
    for ((position, element) in toolCalls.withIndex()) {
        val item = element as? JsonObject ?: continue
        val index = item.int("index") ?: position
        val call = calls.getOrPut(index) { OpenAiToolCall() }
        item.string("id")?.let { call.id = it }
        val function = item["function"] as? JsonObject
        function?.string("name")?.let { call.name = it }
        function?.string("arguments")?.let { call.arguments.append(it) }
    }
    return toolCallsReply(text, calls.mapValues { it.value.toToolCallOrNull() })
}

private fun OpenAiToolCall.toToolCallOrNull(): ToolCall? {
    val callName = name ?: return null
    val arguments = parseArguments(arguments.toString()) ?: return null
    return ToolCall(id ?: "call-${callName.hashCode()}", callName, arguments)
}

private fun toolCallsReply(text: String, calls: Map<Int, ToolCall?>): ModelReply {
    if (calls.values.any { it == null }) {
        return ModelReply.Failure("tool-arguments", "model returned invalid tool-call arguments")
    }
    val resolved = calls.entries.sortedBy { it.key }.mapNotNull { it.value }
    if (resolved.isEmpty()) {
        return if (text.isNotBlank()) ModelReply.Text(text) else {
            ModelReply.Failure("empty-reply", "model returned no text or tool calls")
        }
    }
    return ModelReply.Calls(resolved, text.ifBlank { null })
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

private fun responsesInput(messages: List<AgentMessage>): JsonArray = buildJsonArray {
    for (message in messages) {
        when (message) {
            is AgentMessage.System -> Unit // sent as instructions
            is AgentMessage.User -> add(
                buildJsonObject {
                    put("role", "user")
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "input_text"); put("text", message.text) })
                    })
                },
            )

            is AgentMessage.Assistant -> {
                if (!message.text.isNullOrEmpty()) {
                    add(
                        buildJsonObject {
                            put("role", "assistant")
                            // Responses input messages accept a plain string here;
                            // output_text is an output-item content type, not an
                            // input content type.
                            put("content", message.text)
                        },
                    )
                }
                for (call in message.calls) {
                    add(
                        buildJsonObject {
                            put("type", "function_call")
                            put("call_id", call.id)
                            put("name", call.name)
                            put("arguments", call.arguments.toJsonElement().toString())
                        },
                    )
                }
            }

            is AgentMessage.Tool -> add(
                buildJsonObject {
                    put("type", "function_call_output")
                    put("call_id", message.callId)
                    put("output", message.content)
                },
            )
        }
    }
}

private fun responsesTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
    for (tool in tools) {
        add(
            buildJsonObject {
                put("type", "function")
                put("name", tool.name)
                put("description", tool.description)
                put("parameters", tool.parameters.toJsonElement())
            },
        )
    }
}

private fun parseResponsesResponse(body: String): ModelReply {
    val root = parseObject(body) ?: return ModelReply.Failure("protocol-error", "invalid JSON from provider")
    providerError(root)?.let { return it }
    val status = root.string("status")
    if (status == "failed") {
        return ModelReply.Failure("provider-error", "provider reported a failed response")
    }
    val output = root["output"] as? JsonArray
        ?: return ModelReply.Failure("protocol-error", "missing output array")
    val text = StringBuilder()
    val calls = mutableListOf<ToolCall>()
    for (element in output) {
        val item = element as? JsonObject ?: continue
        when (item.string("type")) {
            "message" -> {
                val content = item["content"] as? JsonArray ?: continue
                for (partElement in content) {
                    val part = partElement as? JsonObject ?: continue
                    val partType = part.string("type")
                    if (partType == "output_text" || partType == "text") {
                        part.string("text")?.let { text.append(it) }
                    }
                }
            }

            "function_call" -> {
                val name = item.string("name") ?: return ModelReply.Failure("protocol-error", "function_call without name")
                val callId = item.string("call_id") ?: item.string("id") ?: "call-${calls.size}"
                val arguments = parseArguments(item.string("arguments").orEmpty())
                    ?: return ModelReply.Failure("tool-arguments", "model returned invalid tool-call arguments")
                calls += ToolCall(callId, name, arguments)
            }
        }
    }
    if (calls.isNotEmpty()) return ModelReply.Calls(calls, text.toString().ifBlank { null })
    return if (text.isNotBlank()) ModelReply.Text(text.toString()) else {
        ModelReply.Failure("empty-reply", "model returned no text or tool calls")
    }
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

private fun anthropicMessages(messages: List<AgentMessage>): JsonArray = buildJsonArray {
    var index = 0
    while (index < messages.size) {
        when (val message = messages[index]) {
            is AgentMessage.System -> index += 1
            is AgentMessage.User -> {
                add(
                    buildJsonObject {
                        put("role", "user")
                        put("content", buildJsonArray {
                            add(buildJsonObject { put("type", "text"); put("text", message.text) })
                        })
                    },
                )
                index += 1
            }

            is AgentMessage.Assistant -> {
                val content = buildJsonArray {
                    if (!message.text.isNullOrEmpty()) {
                        add(buildJsonObject { put("type", "text"); put("text", message.text) })
                    }
                    for (call in message.calls) {
                        add(
                            buildJsonObject {
                                put("type", "tool_use")
                                put("id", call.id)
                                put("name", call.name)
                                put("input", call.arguments.toJsonElement())
                            },
                        )
                    }
                }
                if (content.isNotEmpty()) {
                    add(buildJsonObject { put("role", "assistant"); put("content", content) })
                }
                index += 1
            }

            is AgentMessage.Tool -> {
                val results = buildJsonArray {
                    while (index < messages.size && messages[index] is AgentMessage.Tool) {
                        val tool = messages[index] as AgentMessage.Tool
                        add(
                            buildJsonObject {
                                put("type", "tool_result")
                                put("tool_use_id", tool.callId)
                                put("content", tool.content)
                            },
                        )
                        index += 1
                    }
                }
                add(buildJsonObject { put("role", "user"); put("content", results) })
            }
        }
    }
}

private fun anthropicTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
    for (tool in tools) {
        add(
            buildJsonObject {
                put("name", tool.name)
                put("description", tool.description)
                put("input_schema", tool.parameters.toJsonElement())
            },
        )
    }
}

private class AnthropicToolCall {
    var id: String? = null
    var name: String? = null
    val arguments = StringBuilder()
    var initial: JsonObject? = null
}

private fun parseAnthropicResponse(body: String): ModelReply {
    val text = StringBuilder()
    val calls = linkedMapOf<Int, AnthropicToolCall>()
    var stopReason: String? = null
    var blockedReason: String? = null
    for (event in parseSse(body)) {
        val data = event.data.trim()
        if (data.isEmpty()) continue
        val root = parseObject(data) ?: return ModelReply.Failure("protocol-error", "invalid SSE JSON from provider")
        val type = event.event ?: root.string("type") ?: ""
        providerError(root)?.let { return it }
        when (type) {
            "error" -> return ModelReply.Failure("provider-error", providerMessage(data))
            "content_block_start" -> {
                val blockIndex = root.int("index") ?: 0
                val block = root["content_block"] as? JsonObject ?: continue
                if (block.string("type") == "tool_use") {
                    val call = calls.getOrPut(blockIndex) { AnthropicToolCall() }
                    block.string("id")?.let { call.id = it }
                    block.string("name")?.let { call.name = it }
                    (block["input"] as? JsonObject)?.takeIf { it.isNotEmpty() }?.let { call.initial = it }
                }
            }

            "content_block_delta" -> {
                val blockIndex = root.int("index") ?: 0
                val delta = root["delta"] as? JsonObject ?: continue
                when (delta.string("type")) {
                    "text_delta" -> delta.string("text")?.let { text.append(it) }
                    "input_json_delta" -> {
                        val call = calls.getOrPut(blockIndex) { AnthropicToolCall() }
                        delta.string("partial_json")?.let { call.arguments.append(it) }
                    }
                }
            }

            "message_delta" -> {
                stopReason = (root["delta"] as? JsonObject)?.string("stop_reason") ?: stopReason
            }

            "message_start", "message_stop", "content_block_stop", "ping" -> Unit
            else -> {
                if (root.string("type") == "error") return ModelReply.Failure("provider-error", providerMessage(data))
                root.string("block_reason")?.let { blockedReason = it }
            }
        }
    }
    if (blockedReason != null) {
        return ModelReply.Failure("provider-blocked", "provider stopped the response: $blockedReason")
    }
    val resolved = calls.entries.sortedBy { it.key }.mapNotNull { (_, call) ->
        val name = call.name ?: return@mapNotNull null
        val arguments = when {
            call.arguments.isNotBlank() -> parseArguments(call.arguments.toString()) ?: return@mapNotNull null
            call.initial != null -> call.initial!!.toPlainMap()
            else -> emptyMap()
        }
        ToolCall(call.id ?: "call-$name", name, arguments)
    }
    if (calls.isNotEmpty() && resolved.size != calls.size) {
        return ModelReply.Failure("tool-arguments", "model returned invalid tool-call arguments")
    }
    if (resolved.isNotEmpty()) return ModelReply.Calls(resolved, text.toString().ifBlank { null })
    if (stopReason == "tool_use") {
        return ModelReply.Failure("protocol-error", "provider stopped for tool_use without a tool call")
    }
    return if (text.isNotBlank()) ModelReply.Text(text.toString()) else {
        ModelReply.Failure("empty-reply", "model returned no text or tool calls")
    }
}

// ---------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------

private fun geminiContents(messages: List<AgentMessage>): JsonArray = buildJsonArray {
    var index = 0
    while (index < messages.size) {
        when (val message = messages[index]) {
            is AgentMessage.System -> index += 1
            is AgentMessage.User -> {
                add(
                    buildJsonObject {
                        put("role", "user")
                        put("parts", buildJsonArray { add(buildJsonObject { put("text", message.text) }) })
                    },
                )
                index += 1
            }

            is AgentMessage.Assistant -> {
                val parts = buildJsonArray {
                    if (!message.text.isNullOrEmpty()) {
                        add(buildJsonObject { put("text", message.text) })
                    }
                    for (call in message.calls) {
                        add(
                            buildJsonObject {
                                put(
                                    "functionCall",
                                    buildJsonObject {
                                        put("name", call.name)
                                        put("args", call.arguments.toJsonElement())
                                    },
                                )
                            },
                        )
                    }
                }
                if (parts.isNotEmpty()) {
                    add(buildJsonObject { put("role", "model"); put("parts", parts) })
                }
                index += 1
            }

            is AgentMessage.Tool -> {
                val parts = buildJsonArray {
                    while (index < messages.size && messages[index] is AgentMessage.Tool) {
                        val tool = messages[index] as AgentMessage.Tool
                        add(
                            buildJsonObject {
                                put(
                                    "functionResponse",
                                    buildJsonObject {
                                        put("name", tool.name)
                                        put(
                                            "response",
                                            buildJsonObject { put("content", tool.content) },
                                        )
                                    },
                                )
                            },
                        )
                        index += 1
                    }
                }
                add(buildJsonObject { put("role", "user"); put("parts", parts) })
            }
        }
    }
}

private fun geminiTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
    for (tool in tools) {
        add(
            buildJsonObject {
                put("name", tool.name)
                put("description", tool.description)
                put("parameters", geminiSchema(tool.parameters))
            },
        )
    }
}

/**
 * Gemini's function schema uses uppercase type names (OBJECT/STRING/ARRAY),
 * while the tool specs and the other providers use ordinary OpenAPI casing.
 */
private fun geminiSchema(value: Any?): JsonElement = when (value) {
    is Map<*, *> -> buildJsonObject {
        for ((key, child) in value) {
            if (key == "type" && child is String) {
                put("type", child.uppercase())
            } else {
                put(key.toString(), geminiSchema(child))
            }
        }
    }

    is Iterable<*> -> buildJsonArray { for (child in value) add(geminiSchema(child)) }
    is Array<*> -> buildJsonArray { for (child in value) add(geminiSchema(child)) }
    else -> value.toJsonElement()
}

private fun parseGeminiResponse(body: String): ModelReply {
    val text = StringBuilder()
    val calls = mutableListOf<ToolCall>()
    var finishReason: String? = null
    var blockReason: String? = null
    val events = parseSse(body)
    if (events.isEmpty()) {
        val root = parseObject(body) ?: return ModelReply.Failure("protocol-error", "invalid JSON from provider")
        parseGeminiRoot(root, text, calls)?.let { return it }
        blockReason = root.geminiBlockReason()
    } else {
        for (event in events) {
            val data = event.data.trim()
            if (data.isEmpty()) continue
            if (event.event == "error") return ModelReply.Failure("provider-error", providerMessage(data))
            val root = parseObject(data) ?: return ModelReply.Failure("protocol-error", "invalid SSE JSON from provider")
            providerError(root)?.let { return it }
            parseGeminiRoot(root, text, calls)?.let { return it }
            blockReason = root.geminiBlockReason() ?: blockReason
            finishReason = root.geminiFinishReason() ?: finishReason
        }
    }
    if (calls.isNotEmpty()) return ModelReply.Calls(calls, text.toString().ifBlank { null })
    if (text.isNotBlank()) return ModelReply.Text(text.toString())
    if (blockReason != null) {
        return ModelReply.Failure("provider-blocked", "provider stopped the response: $blockReason")
    }
    if (finishReason != null && finishReason != "STOP") {
        return ModelReply.Failure("provider-stop", "provider stopped with finish reason $finishReason")
    }
    return ModelReply.Failure("empty-reply", "model returned no text or tool calls")
}

private fun parseGeminiRoot(
    root: JsonObject,
    text: StringBuilder,
    calls: MutableList<ToolCall>,
): ModelReply? {
    val candidates = root["candidates"] as? JsonArray ?: return null
    for (candidateElement in candidates) {
        val candidate = candidateElement as? JsonObject ?: continue
        val content = candidate["content"] as? JsonObject ?: continue
        val parts = content["parts"] as? JsonArray ?: continue
        for (partElement in parts) {
            val part = partElement as? JsonObject ?: continue
            if ((part["thought"] as? JsonPrimitive)?.booleanOrNull == true) continue
            part.string("text")?.let { text.append(it) }
            val functionCall = part["functionCall"] as? JsonObject ?: continue
            val name = functionCall.string("name")
                ?: return ModelReply.Failure("protocol-error", "Gemini functionCall without name")
            val args = (functionCall["args"] as? JsonObject)?.toPlainMap() ?: emptyMap()
            calls += ToolCall("gemini-${calls.size + 1}", name, args)
        }
    }
    return null
}

private fun JsonObject.geminiBlockReason(): String? {
    val feedback = this["promptFeedback"] as? JsonObject ?: return null
    return feedback.string("blockReason")
}

private fun JsonObject.geminiFinishReason(): String? {
    val candidate = (this["candidates"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return null
    return candidate.string("finishReason")
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

private val modelJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

private fun parseObject(text: String): JsonObject? = try {
    modelJson.parseToJsonElement(text) as? JsonObject
} catch (_: Exception) {
    null
}

private fun parseArguments(raw: String): Map<String, Any?>? {
    if (raw.isBlank()) return emptyMap()
    val value = parseObject(raw) ?: return null
    return value.toPlainMap()
}

private fun JsonObject.toPlainMap(): Map<String, Any?> =
    entries.associate { (key, value) -> key to value.toPlain() }

private fun JsonElement.toPlain(): Any? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> when {
        isString -> content
        booleanOrNull != null -> booleanOrNull
        longOrNull != null -> longOrNull
        doubleOrNull != null -> doubleOrNull
        else -> content
    }

    is JsonObject -> toPlainMap()
    is JsonArray -> map { it.toPlain() }
}

private fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Int -> JsonPrimitive(this)
    is Long -> JsonPrimitive(this)
    is Double -> JsonPrimitive(this)
    is Float -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this.toString())
    is Map<*, *> -> buildJsonObject {
        for ((key, value) in this@toJsonElement) {
            put(key.toString(), value.toJsonElement())
        }
    }

    is Iterable<*> -> buildJsonArray { for (value in this@toJsonElement) add(value.toJsonElement()) }
    is Array<*> -> buildJsonArray { for (value in this@toJsonElement) add(value.toJsonElement()) }
    else -> JsonPrimitive(this.toString())
}

private fun JsonObject.string(name: String): String? =
    (this[name] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.int(name: String): Int? =
    (this[name] as? JsonPrimitive)?.intOrNull

private fun JsonElement?.textContent(): String? = when (this) {
    is JsonPrimitive -> if (isString) content else null
    is JsonArray -> mapNotNull { part ->
        (part as? JsonObject)?.string("text")
    }.joinToString("").ifBlank { null }

    else -> null
}

private fun providerError(root: JsonObject): ModelReply? {
    val error = root["error"] as? JsonObject ?: return null
    val message = error.string("message") ?: "provider returned an error"
    return ModelReply.Failure("provider-error", message.take(500))
}

private fun providerMessage(data: String): String {
    val root = parseObject(data)
    val error = root?.get("error") as? JsonObject
    return error?.string("message")?.take(500) ?: data.replace(Regex("\\s+"), " ").take(500)
}


/**
 * Cloud credentials must not cross a plaintext public network. HTTPS is
 * required; HTTP is allowed only for an explicit loopback test endpoint.
 */
fun modelBaseUrlAllowed(baseUrl: String): Boolean {
    val uri = try {
        URI(baseUrl.trim())
    } catch (_: Exception) {
        return false
    }
    return when (uri.scheme?.lowercase()) {
        "https" -> true
        "http" -> uri.host?.lowercase() in setOf("127.0.0.1", "localhost", "::1", "[::1]")
        else -> false
    }
}
