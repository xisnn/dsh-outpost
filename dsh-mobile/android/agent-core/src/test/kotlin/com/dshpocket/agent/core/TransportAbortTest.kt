package com.dshpocket.agent.core

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * P4-0.3 #25 — network abort. HttpURLConnection socket reads ignore thread
 * interrupts, so UrlConnectionTransport.abort() must disconnect the active
 * connection and the blocked call must fail visibly and promptly.
 */
class TransportAbortTest {
    @Test
    fun `abort disconnects an in-flight stream promptly`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            Thread.sleep(3000)
            val bytes = "data: hi\n\n".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val transport = UrlConnectionTransport()
            val entered = CountDownLatch(1)
            val error = AtomicReference<Throwable>()
            val worker = Thread {
                try {
                    entered.countDown()
                    transport.stream(HttpRequest("http://127.0.0.1:${server.address.port}/", emptyMap(), "{}")) { }
                } catch (t: Throwable) {
                    error.set(t)
                }
            }
            val t0 = System.currentTimeMillis()
            worker.start()
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            Thread.sleep(300)
            transport.abort()
            worker.join(2500)
            val elapsed = System.currentTimeMillis() - t0
            assertFalse("worker still blocked after abort", worker.isAlive)
            assertNotNull("abort must surface a visible transport error", error.get())
            assertTrue("abort took ${elapsed}ms", elapsed < 2500)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `cloud client aborted before request fails with aborted code`() {
        val client = CloudModelClient(
            ModelConfig(ModelProtocol.OPENAI_COMPAT, "http://127.0.0.1:9", "m", "k"),
        )
        client.abort()
        val reply = client.complete(ModelRequest(emptyList(), emptyList()))
        assertTrue(reply is ModelReply.Failure)
        assertEquals("aborted", (reply as ModelReply.Failure).code)
    }

    private fun assertFalse(message: String, condition: Boolean) {
        assertTrue(message, !condition)
    }
}
