package com.dshpocket.agent.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudModelClientTest {
    private class FakeTransport(private val response: HttpResponse) : HttpTransport {
        lateinit var request: HttpRequest
        override fun post(request: HttpRequest): HttpResponse {
            this.request = request
            return response
        }
    }

    private val tools = listOf(
        ToolSpec(
            name = "workspace_read",
            description = "Read a file",
            parameters = mapOf(
                "type" to "object",
                "properties" to mapOf("path" to mapOf("type" to "string")),
                "required" to listOf("path"),
            ),
        ),
    )

    private fun config(protocol: ModelProtocol, baseUrl: String) =
        ModelConfig(protocol, baseUrl, "test-model", "test-key")

    private fun request() = ModelRequest(
        messages = listOf(AgentMessage.System("system prompt"), AgentMessage.User("read input.txt")),
        tools = tools,
    )

    private fun bodyOf(transport: FakeTransport): JsonObject =
        Json.parseToJsonElement(transport.request.body).jsonObject

    private fun sse(vararg events: String) = events.joinToString("\n\n")

    @Test
    fun `openai compatible streams text and sends bearer auth`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
                    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}",
                    "data: [DONE]",
                ),
            ),
        )
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1"), transport)
            .complete(request())

        assertTrue(reply is ModelReply.Text)
        assertEquals("Hello world", (reply as ModelReply.Text).text)
        assertEquals("https://api.example/v1/chat/completions", transport.request.url)
        assertEquals("Bearer test-key", transport.request.headers["Authorization"])
        val body = bodyOf(transport)
        assertEquals("test-model", body["model"]!!.jsonPrimitive.content)
        assertTrue(body["stream"]!!.jsonPrimitive.content == "true")
        assertEquals("system", body["messages"]!!.jsonArray[0].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("function", body["tools"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `openai compatible emits text deltas while streaming`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
                    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}",
                    "data: [DONE]",
                ),
            ),
        )
        val deltas = mutableListOf<String>()
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1"), transport)
            .complete(request()) { deltas += it }

        assertEquals(listOf("Hello", " world"), deltas)
        assertEquals("Hello world", (reply as ModelReply.Text).text)
    }

    @Test
    fun `openai compatible accumulates streamed tool call arguments`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"workspace_read\",\"arguments\":\"{\\\"path\\\":\\\"\"}}]}}]}",
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"input.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}",
                    "data: [DONE]",
                ),
            ),
        )
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1"), transport)
            .complete(request())

        assertTrue(reply is ModelReply.Calls)
        val call = (reply as ModelReply.Calls).calls.single()
        assertEquals("call_1", call.id)
        assertEquals("workspace_read", call.name)
        assertEquals("input.txt", call.arguments["path"])
    }

    @Test
    fun `openai responses parses output message and function call`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                """
                {
                  "status": "completed",
                  "output": [
                    {"type":"message","content":[{"type":"output_text","text":"working"}]},
                    {"type":"function_call","call_id":"call_2","name":"workspace_read","arguments":"{\"path\":\"input.txt\"}"}
                  ]
                }
                """.trimIndent(),
            ),
        )
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_RESPONSES, "https://api.example/v1"), transport)
            .complete(request())

        assertTrue(reply is ModelReply.Calls)
        val calls = (reply as ModelReply.Calls)
        assertEquals("working", calls.text)
        assertEquals("call_2", calls.calls.single().id)
        assertEquals("input.txt", calls.calls.single().arguments["path"])
        assertEquals("https://api.example/v1/responses", transport.request.url)
        assertEquals("Bearer test-key", transport.request.headers["Authorization"])
        val body = bodyOf(transport)
        assertEquals("system prompt", body["instructions"]!!.jsonPrimitive.content)
        assertEquals("function", body["tools"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("user", body["input"]!!.jsonArray[0].jsonObject["role"]!!.jsonPrimitive.content)
    }

    @Test
    fun `anthropic maps system and parses text deltas`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}",
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}",
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" Claude\"}}",
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}",
                    "event: message_stop\ndata: {\"type\":\"message_stop\"}",
                ),
            ),
        )
        val reply = CloudModelClient(config(ModelProtocol.ANTHROPIC, "https://api.anthropic.com"), transport)
            .complete(request())

        assertTrue(reply is ModelReply.Text)
        assertEquals("Hello Claude", (reply as ModelReply.Text).text)
        assertEquals("https://api.anthropic.com/v1/messages", transport.request.url)
        assertEquals("test-key", transport.request.headers["x-api-key"])
        assertEquals("2023-06-01", transport.request.headers["anthropic-version"])
        val body = bodyOf(transport)
        assertEquals("system prompt", body["system"]!!.jsonPrimitive.content)
        assertEquals("input_schema", body["tools"]!!.jsonArray[0].jsonObject.keys.first { it == "input_schema" })
    }

    @Test
    fun `anthropic parses tool use with streamed json input`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"workspace_read\",\"input\":{}}}",
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"input.txt\\\"}\"}}",
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}",
                    "event: message_stop\ndata: {\"type\":\"message_stop\"}",
                ),
            ),
        )
        val reply = CloudModelClient(config(ModelProtocol.ANTHROPIC, "https://api.anthropic.com"), transport)
            .complete(request())

        assertTrue(reply is ModelReply.Calls)
        val call = (reply as ModelReply.Calls).calls.single()
        assertEquals("toolu_1", call.id)
        assertEquals("workspace_read", call.name)
        assertEquals("input.txt", call.arguments["path"])
    }

    @Test
    fun `gemini parses text and sends api key header`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                sse(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello \"}]}}]}",
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini\"}]},\"finishReason\":\"STOP\"}]}",
                ),
            ),
        )
        val reply = CloudModelClient(
            config(ModelProtocol.GEMINI, "https://generativelanguage.googleapis.com"),
            transport,
        ).complete(request())

        assertTrue(reply is ModelReply.Text)
        assertEquals("Hello Gemini", (reply as ModelReply.Text).text)
        assertEquals(
            "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse",
            transport.request.url,
        )
        assertEquals("test-key", transport.request.headers["x-goog-api-key"])
        val body = bodyOf(transport)
        assertNotNull(body["systemInstruction"])
        val declaration = body["tools"]!!.jsonArray[0].jsonObject["functionDeclarations"]!!.jsonArray[0].jsonObject
        assertEquals("workspace_read", declaration["name"]!!.jsonPrimitive.content)
        val parameters = declaration["parameters"]!!.jsonObject
        assertEquals("OBJECT", parameters["type"]!!.jsonPrimitive.content)
        assertEquals(
            "STRING",
            parameters["properties"]!!.jsonObject["path"]!!.jsonObject["type"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `gemini parses function call`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"workspace_read\",\"args\":{\"path\":\"input.txt\"}}}]},\"finishReason\":\"STOP\"}]}",
            ),
        )
        val reply = CloudModelClient(
            config(ModelProtocol.GEMINI, "https://generativelanguage.googleapis.com"),
            transport,
        ).complete(request())

        assertTrue(reply is ModelReply.Calls)
        val call = (reply as ModelReply.Calls).calls.single()
        assertEquals("workspace_read", call.name)
        assertEquals("input.txt", call.arguments["path"])
        assertEquals("gemini-1", call.id)
    }

    @Test
    fun `http errors and missing key are visible failures`() {
        val transport = FakeTransport(HttpResponse(401, "{\"error\":{\"message\":\"bad key test-key\"}}"))
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1"), transport)
            .complete(request())
        assertTrue(reply is ModelReply.Failure)
        assertEquals("http-401", (reply as ModelReply.Failure).code)
        assertTrue(reply.message.contains("bad key"))
        assertFalse(reply.message.contains("test-key"))

        val missing = CloudModelClient(
            ModelConfig(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1", "test-model", ""),
            FakeTransport(HttpResponse(200, "{}")),
        ).complete(request())
        assertEquals("missing-key", (missing as ModelReply.Failure).code)
    }

    @Test
    fun `plaintext public base url is rejected before transport`() {
        val transport = FakeTransport(HttpResponse(200, "should not be called"))
        val reply = CloudModelClient(
            config(ModelProtocol.OPENAI_COMPAT, "http://api.example/v1"),
            transport,
        ).complete(request())
        assertTrue(reply is ModelReply.Failure)
        assertEquals("insecure-base-url", (reply as ModelReply.Failure).code)
    }

    @Test
    fun `malformed provider data does not become an empty success`() {
        val transport = FakeTransport(HttpResponse(200, "data: not-json"))
        val reply = CloudModelClient(config(ModelProtocol.OPENAI_COMPAT, "https://api.example/v1"), transport)
            .complete(request())
        assertTrue(reply is ModelReply.Failure)
        assertEquals("protocol-error", (reply as ModelReply.Failure).code)
    }

    @Test
    fun `anthropic maps tool results back into user tool result blocks`() {
        val transport = FakeTransport(
            HttpResponse(
                200,
                "event: message_delta\n" +
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n" +
                    "event: content_block_delta\n" +
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}",
            ),
        )
        val history = ModelRequest(
            messages = listOf(
                AgentMessage.System("sys"),
                AgentMessage.User("read"),
                AgentMessage.Assistant(null, listOf(ToolCall("toolu_1", "workspace_read", mapOf("path" to "input.txt")))),
                AgentMessage.Tool("toolu_1", "workspace_read", "contents"),
            ),
            tools = tools,
        )
        CloudModelClient(config(ModelProtocol.ANTHROPIC, "https://api.anthropic.com"), transport)
            .complete(history)

        val messages = bodyOf(transport)["messages"]!!.jsonArray
        assertEquals("assistant", messages[1].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("tool_use", messages[1].jsonObject["content"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("user", messages[2].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("tool_result", messages[2].jsonObject["content"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("toolu_1", messages[2].jsonObject["content"]!!.jsonArray[0].jsonObject["tool_use_id"]!!.jsonPrimitive.content)
    }
}
