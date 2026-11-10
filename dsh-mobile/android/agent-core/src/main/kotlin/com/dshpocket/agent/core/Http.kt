package com.dshpocket.agent.core

import java.net.HttpURLConnection
import java.net.URL

data class HttpRequest(
    val url: String,
    val headers: Map<String, String>,
    val body: String,
    val connectTimeoutMs: Int = 15_000,
    val readTimeoutMs: Int = 120_000,
)

data class HttpResponse(
    val status: Int,
    val body: String,
    val contentType: String? = null,
)

/** Small seam for adapter tests; production uses [UrlConnectionTransport]. */
interface HttpTransport {
    fun post(request: HttpRequest): HttpResponse

    /**
     * Streaming variant. Default transports that cannot stream still give the
     * same events after the complete body arrives; UrlConnectionTransport
     * overrides this to emit events while reading.
     */
    fun stream(request: HttpRequest, onEvent: (SseEvent) -> Unit): HttpResponse {
        val response = post(request)
        parseSse(response.body).forEach(onEvent)
        return response
    }
}

/**
 * No redirects are followed: a 3xx is returned to the adapter as a failure so an
 * Authorization header is never replayed to a different host.
 */
class UrlConnectionTransport : HttpTransport {
    override fun post(request: HttpRequest): HttpResponse {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = request.connectTimeoutMs
            connection.readTimeout = request.readTimeoutMs
            connection.doInput = true
            connection.doOutput = true
            connection.setRequestProperty("Accept", "text/event-stream, application/json")
            connection.setRequestProperty("User-Agent", "dsh-outpost-agent/0.18")
            for ((name, value) in request.headers) {
                connection.setRequestProperty(name, value)
            }
            val bytes = request.body.toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return HttpResponse(status, body, connection.contentType)
        } finally {
            connection.disconnect()
        }
    }

    override fun stream(request: HttpRequest, onEvent: (SseEvent) -> Unit): HttpResponse {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = request.connectTimeoutMs
            connection.readTimeout = request.readTimeoutMs
            connection.doInput = true
            connection.doOutput = true
            connection.setRequestProperty("Accept", "text/event-stream, application/json")
            connection.setRequestProperty("User-Agent", "dsh-outpost-agent/0.18")
            for ((name, value) in request.headers) {
                connection.setRequestProperty(name, value)
            }
            val bytes = request.body.toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status !in 200..299) {
                val body = connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                return HttpResponse(status, body, connection.contentType)
            }
            val raw = StringBuilder()
            val accumulator = SseAccumulator(onEvent)
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    raw.append(line).append('\n')
                    accumulator.line(line)
                }
            }
            accumulator.finish()
            return HttpResponse(status, raw.toString(), connection.contentType)
        } finally {
            connection.disconnect()
        }
    }
}

private class SseAccumulator(private val onEvent: (SseEvent) -> Unit) {
    private var event: String? = null
    private val data = StringBuilder()

    fun line(raw: String) {
        val line = raw.removeSuffix("\r")
        when {
            line.isEmpty() -> dispatch()
            line.startsWith(":") -> Unit
            else -> {
                val colon = line.indexOf(':')
                val field = if (colon < 0) line else line.substring(0, colon)
                var value = if (colon < 0) "" else line.substring(colon + 1)
                if (value.startsWith(" ")) value = value.substring(1)
                when (field) {
                    "event" -> event = value
                    "data" -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(value)
                    }
                }
            }
        }
    }

    fun finish() {
        dispatch()
    }

    private fun dispatch() {
        if (data.isNotEmpty()) onEvent(SseEvent(event, data.toString()))
        event = null
        data.setLength(0)
    }
}

data class SseEvent(
    val event: String?,
    val data: String,
)

/** Parses a complete SSE body into events. Multi-line data fields are joined with LF. */
fun parseSse(body: String): List<SseEvent> {
    val events = mutableListOf<SseEvent>()
    var event: String? = null
    val data = StringBuilder()
    fun dispatch() {
        if (data.isNotEmpty()) {
            events += SseEvent(event, data.toString())
        }
        event = null
        data.setLength(0)
    }
    for (raw in body.lineSequence()) {
        val line = raw.removeSuffix("\r")
        when {
            line.isEmpty() -> dispatch()
            line.startsWith(":") -> Unit
            else -> {
                val colon = line.indexOf(':')
                val field = if (colon < 0) line else line.substring(0, colon)
                var value = if (colon < 0) "" else line.substring(colon + 1)
                if (value.startsWith(" ")) value = value.substring(1)
                when (field) {
                    "event" -> event = value
                    "data" -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(value)
                    }
                }
            }
        }
    }
    dispatch()
    return events
}
