package com.dshpocket.agent

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket

/**
 * P4-0.3 #22 — emulator-level integration of the screen-off pause / unlock
 * recovery wiring (AgentService receiver -> AgentRuntime -> ScreenPausePolicy).
 * A loopback stub model with a delayed reply gives a deterministic in-flight
 * window; no cloud model is called and no real user data is touched.
 * (Android has no com.sun.net.httpserver; a raw ServerSocket speaks minimal HTTP.)
 */
class ScreenOffRecoveryTest {
    private fun stubServer(delayMs: Long): ServerSocket {
        val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val acceptor = Thread {
            try {
                while (!socket.isClosed) {
                    val client = socket.accept()
                    Thread {
                        try {
                            client.use { c ->
                                val reader = c.getInputStream().bufferedReader()
                                while (true) {
                                    val line = reader.readLine() ?: break
                                    if (line.isEmpty()) break
                                }
                                Thread.sleep(delayMs)
                                val body =
                                    "data: {\"choices\":[{\"delta\":{\"content\":\"RECOVERY_OK\"}}]}\n\n" +
                                        "data: [DONE]\n\n"
                                val bytes = body.toByteArray()
                                val out = c.getOutputStream()
                                out.write(
                                    (
                                        "HTTP/1.1 200 OK\r\n" +
                                            "Content-Type: text/event-stream\r\n" +
                                            "Content-Length: ${bytes.size}\r\n" +
                                            "Connection: close\r\n\r\n"
                                        ).toByteArray() + bytes,
                                )
                                out.flush()
                            }
                        } catch (_: Exception) {
                        }
                    }.start()
                }
            } catch (_: Exception) {
            }
        }
        acceptor.isDaemon = true
        acceptor.start()
        return socket
    }

    @Test
    fun screenOffPausesAndUnlockResumes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val server = stubServer(1500)
        val runtime = AgentRuntime.get(context)
        try {
            AgentSettingsStore(context).save(
                "OPENAI_COMPAT",
                "http://127.0.0.1:${server.localPort}",
                "stub",
                "test-key",
            )
            runtime.startCloud("screen-off recovery test")
            Thread.sleep(500) // model request is in flight (server delays 1500ms)
            runtime.pauseForScreenOff()
            var snap = runtime.snapshot()
            assertTrue("screen-off must pause the run", snap.optBoolean("paused"))
            assertTrue(snap.optBoolean("screenOffPaused"))
            Thread.sleep(1800) // reply arrives; the loop must block, not complete
            snap = runtime.snapshot()
            assertTrue("run must stay paused while screen off", snap.optBoolean("paused"))
            assertNotEquals("completed", snap.optString("phase"))
            runtime.resumeFromScreenOff()
            val deadline = System.currentTimeMillis() + 8000
            var done = false
            while (System.currentTimeMillis() < deadline) {
                snap = runtime.snapshot()
                if (snap.optString("phase") == "completed") {
                    done = true
                    break
                }
                Thread.sleep(100)
            }
            assertTrue("run should complete after unlock", done)
            assertTrue(snap.optString("text").contains("RECOVERY_OK"))
            assertFalse(snap.optBoolean("screenOffPaused"))
        } finally {
            runtime.stop()
            AgentSettingsStore(context).clear()
            server.close()
        }
    }

    @Test
    fun userPauseIsNeverOverriddenByScreenCycle() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val server = stubServer(800)
        val runtime = AgentRuntime.get(context)
        try {
            AgentSettingsStore(context).save(
                "OPENAI_COMPAT",
                "http://127.0.0.1:${server.localPort}",
                "stub",
                "test-key",
            )
            runtime.startCloud("user pause precedence test")
            Thread.sleep(200)
            runtime.pause() // explicit user pause
            runtime.pauseForScreenOff()
            var snap = runtime.snapshot()
            assertTrue(snap.optBoolean("paused"))
            assertFalse("user pause must not become a screen-off pause", snap.optBoolean("screenOffPaused"))
            runtime.resumeFromScreenOff()
            snap = runtime.snapshot()
            assertTrue("unlock must not resume a user pause", snap.optBoolean("paused"))
            assertFalse(snap.optBoolean("screenOffPaused"))
        } finally {
            runtime.stop()
            val deadline = System.currentTimeMillis() + 3000
            while (System.currentTimeMillis() < deadline) {
                val phase = runtime.snapshot().optString("phase")
                if (phase != "running" && phase != "queued" && phase != "preparing") break
                Thread.sleep(100)
            }
            AgentSettingsStore(context).clear()
            server.close()
        }
    }
}
