package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * P4-0.3 #25 — interruptible tool execution. Abort must break in-flight work
 * promptly, refuse later execution, and never bypass the approval gate.
 */
class ActionExecutorAbortTest {
    private class BlockingTool : AgentTool {
        override val risk = ToolRisk.READ
        override val spec = ToolSpec(name = "block", description = "blocks until aborted", parameters = emptyMap())

        @Volatile
        var abortHookCalled = false

        override fun abort() {
            abortHookCalled = true
        }

        override fun execute(call: ToolCall): ToolOutput {
            while (!abortHookCalled) Thread.sleep(10)
            return ToolOutput(ToolStatus.ERROR, "ABORTED: custom hook")
        }
    }

    private class FixedDelayTool : AgentTool {
        override val risk = ToolRisk.READ
        override val spec = ToolSpec(name = "delay", description = "fixed delay", parameters = emptyMap())
        override fun execute(call: ToolCall): ToolOutput {
            Thread.sleep(150)
            return ToolOutput(ToolStatus.OK, "done")
        }
    }

    private class WriteTool : AgentTool {
        override val risk = ToolRisk.WRITE
        override val spec = ToolSpec(name = "write", description = "needs approval", parameters = emptyMap())
        override fun execute(call: ToolCall): ToolOutput = ToolOutput(ToolStatus.OK, "written")
    }

    @Test
    fun `abortCurrent interrupts an in-flight tool promptly`() {
        val tool = BlockingTool()
        val executor = ActionExecutor(ToolRegistry(listOf(tool)), ApprovalGate { ApprovalDecision.ALLOW_ONCE })
        val started = CountDownLatch(1)
        val result = AtomicReference<ToolResult>()
        val worker = Thread {
            result.set(executor.execute("r", ToolCall("c1", "block", emptyMap())) { started.countDown() })
        }
        val t0 = System.currentTimeMillis()
        worker.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)
        assertTrue(executor.abortCurrent())
        worker.join(2000)
        val elapsed = System.currentTimeMillis() - t0
        assertFalse(worker.isAlive)
        assertTrue(tool.abortHookCalled)
        assertEquals(ToolStatus.ERROR, result.get().status)
        assertTrue(result.get().content.startsWith("ABORTED"))
        assertTrue("abort took ${elapsed}ms", elapsed < 2000)
    }

    @Test
    fun `abort with nothing executing refuses later execution`() {
        val executor = ActionExecutor(ToolRegistry(listOf(FixedDelayTool())), ApprovalGate { ApprovalDecision.ALLOW_ONCE })
        assertFalse(executor.abortCurrent())
        val result = executor.execute("r", ToolCall("c1", "delay", emptyMap()))
        assertEquals(ToolStatus.ERROR, result.status)
        assertEquals("ABORTED: run stopped before execution", result.content)
    }

    @Test
    fun `non-abortable tool completes normally despite abort`() {
        val executor = ActionExecutor(ToolRegistry(listOf(FixedDelayTool())), ApprovalGate { ApprovalDecision.ALLOW_ONCE })
        val result = AtomicReference<ToolResult>()
        val worker = Thread { result.set(executor.execute("r", ToolCall("c1", "delay", emptyMap()))) }
        worker.start()
        Thread.sleep(30)
        assertTrue(executor.abortCurrent())
        worker.join(2000)
        // The interrupt lands inside Thread.sleep -> InterruptedException path.
        // Either outcome is a prompt, visible result; never a hang.
        assertFalse(worker.isAlive)
        assertTrue(result.get().status == ToolStatus.OK || result.get().content.startsWith("ABORTED"))
    }

    @Test
    fun `abort never bypasses the approval gate into execution`() {
        val gateCalls = AtomicInteger(0)
        val executor = ActionExecutor(
            ToolRegistry(listOf(WriteTool())),
            ApprovalGate {
                gateCalls.incrementAndGet()
                ApprovalDecision.REJECT
            },
        )
        executor.abortCurrent()
        val result = executor.execute("r", ToolCall("c1", "write", emptyMap()))
        assertEquals(ToolStatus.ERROR, result.status)
        assertTrue(result.content.startsWith("ABORTED"))
        assertEquals(0, gateCalls.get())
    }
}
