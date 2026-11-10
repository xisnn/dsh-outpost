package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class AgentLoopTest {
    @Rule
    @JvmField
    val temporary = TemporaryFolder()

    private class FakeModel(vararg replies: ModelReply) : ModelClient {
        private val queue = ArrayDeque(replies.toList())
        val requests = mutableListOf<ModelRequest>()

        override fun complete(request: ModelRequest): ModelReply {
            requests += request
            return queue.removeFirstOrNull() ?: ModelReply.Failure("no-reply", "fake model exhausted")
        }
    }

    private class RecordingGate(private val decision: ApprovalDecision) : ApprovalGate {
        val requests = mutableListOf<ApprovalRequest>()
        override fun decide(request: ApprovalRequest): ApprovalDecision {
            requests += request
            return decision
        }
    }

    private fun workspace(): Pair<Workspace, ToolRegistry> {
        val root = temporary.newFolder("workspace").toPath()
        val workspace = Workspace(root)
        return workspace to ToolRegistry(
            listOf(
                WorkspaceReadTool(workspace),
                WorkspaceWriteTool(workspace),
                WorkspaceListTool(workspace),
            ),
        )
    }

    @Test
    fun `read then approved write then final text completes`() {
        val (workspace, registry) = workspace()
        Files.writeString(workspace.root.resolve("input.txt"), "hello")
        val gate = RecordingGate(ApprovalDecision.ALLOW_ONCE)
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "workspace_read", mapOf("path" to "input.txt")))),
            ModelReply.Calls(
                listOf(
                    ToolCall(
                        "c2",
                        "workspace_write",
                        mapOf("path" to "output.txt", "content" to "written by agent"),
                    ),
                ),
            ),
            ModelReply.Text("done"),
        )
        val store = MemoryRunStore()
        val result = AgentLoop(model, ActionExecutor(registry, gate), store)
            .run(RunSpec("run-1", "read then write", maxSteps = 4))

        assertEquals(RunPhase.COMPLETED, result.phase)
        assertEquals("done", result.finalText)
        assertEquals("written by agent", Files.readString(workspace.root.resolve("output.txt")))
        assertEquals(3, model.requests.size)
        assertEquals(ToolStatus.OK, result.toolResults[0].status)
        assertEquals(ToolStatus.OK, result.toolResults[1].status)
        assertEquals(1, gate.requests.size)
        assertEquals("c2", gate.requests[0].call.id)
        assertEquals(digestArguments(gate.requests[0].call.arguments), gate.requests[0].digest)
        assertTrue(result.messages.any { it is AgentMessage.Tool && it.content == "hello" })
        assertEquals(RunPhase.COMPLETED, store.snapshot("run-1")?.phase)
        assertEquals("workspace_write", store.snapshot("run-1")?.lastToolName)
        assertEquals("OK", store.snapshot("run-1")?.lastToolStatus)
        assertEquals("done", store.snapshot("run-1")?.resultText)
    }

    @Test
    fun `rejected write is reported and never touches the file`() {
        val (workspace, registry) = workspace()
        val gate = RecordingGate(ApprovalDecision.REJECT)
        val model = FakeModel(
            ModelReply.Calls(
                listOf(
                    ToolCall("c1", "workspace_write", mapOf("path" to "blocked.txt", "content" to "no")),
                ),
            ),
            ModelReply.Text("blocked by approval"),
        )
        val result = AgentLoop(model, ActionExecutor(registry, gate), MemoryRunStore())
            .run(RunSpec("run-2", "write", maxSteps = 3))

        assertEquals(RunPhase.COMPLETED, result.phase)
        assertEquals(ToolStatus.DENIED, result.toolResults.single().status)
        assertFalse(Files.exists(workspace.root.resolve("blocked.txt")))
        assertTrue(result.messages.any { it is AgentMessage.Tool && it.content.startsWith("DENIED:") })
    }

    private class PhoneVetoTool : AgentTool {
        var executed = false
        override val risk = ToolRisk.PHONE
        override val spec = ToolSpec(
            name = "phone_test",
            description = "phone test tool",
            parameters = mapOf("type" to "object"),
        )

        override fun execute(call: ToolCall): ToolOutput {
            executed = true
            return ToolOutput(ToolStatus.OK, "executed")
        }
    }

    @Test
    fun `pre-execute veto blocks a phone tool after approval`() {
        val tool = PhoneVetoTool()
        val registry = ToolRegistry(listOf(tool))
        val gate = RecordingGate(ApprovalDecision.ALLOW_ONCE)
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "phone_test"))),
            ModelReply.Text("done"),
        )
        val result = AgentLoop(
            model,
            ActionExecutor(registry, gate) { _, _ ->
                ToolOutput(ToolStatus.ERROR, "BACKGROUND_DISPLAY_LOST")
            },
            MemoryRunStore(),
        ).run(RunSpec("run-veto", "veto", maxSteps = 3))

        assertEquals(1, gate.requests.size)
        assertFalse(tool.executed)
        assertEquals(ToolStatus.ERROR, result.toolResults.single().status)
        assertEquals("BACKGROUND_DISPLAY_LOST", result.toolResults.single().content)
        assertEquals(RunPhase.COMPLETED, result.phase)
        assertTrue(result.messages.any { it is AgentMessage.Tool && it.content == "ERROR: BACKGROUND_DISPLAY_LOST" })
    }

    @Test
    fun `pre-approval veto blocks before asking for approval`() {
        val tool = PhoneVetoTool()
        val registry = ToolRegistry(listOf(tool))
        val gate = RecordingGate(ApprovalDecision.ALLOW_ONCE)
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "phone_test"))),
            ModelReply.Text("done"),
        )
        val result = AgentLoop(
            model,
            ActionExecutor(registry, gate, preApproval = { _, _ ->
                ToolOutput(ToolStatus.ERROR, "BACKGROUND_KEY_UNSUPPORTED")
            }),
            MemoryRunStore(),
        ).run(RunSpec("run-preapproval", "veto", maxSteps = 3))

        assertTrue(gate.requests.isEmpty())
        assertFalse(tool.executed)
        assertEquals(ToolStatus.ERROR, result.toolResults.single().status)
        assertEquals("BACKGROUND_KEY_UNSUPPORTED", result.toolResults.single().content)
        assertEquals(RunPhase.COMPLETED, result.phase)
        assertTrue(result.messages.any { it is AgentMessage.Tool && it.content == "ERROR: BACKGROUND_KEY_UNSUPPORTED" })
    }

    @Test
    fun `step budget stops the loop and marks failure`() {
        val (workspace, registry) = workspace()
        Files.writeString(workspace.root.resolve("input.txt"), "x")
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "workspace_read", mapOf("path" to "input.txt")))),
            ModelReply.Text("should not be reached"),
        )
        val result = AgentLoop(model, ActionExecutor(registry, RecordingGate(ApprovalDecision.ALLOW_ONCE)), MemoryRunStore())
            .run(RunSpec("run-3", "loop", maxSteps = 1))

        assertEquals(RunPhase.FAILED, result.phase)
        assertEquals("step-limit", result.error)
        assertEquals(1, model.requests.size)
    }

    @Test
    fun `path traversal is rejected by the execution layer`() {
        val (workspace, registry) = workspace()
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "workspace_write", mapOf("path" to "../escape.txt", "content" to "no")))),
            ModelReply.Text("could not write"),
        )
        val result = AgentLoop(model, ActionExecutor(registry, RecordingGate(ApprovalDecision.ALLOW_ONCE)), MemoryRunStore())
            .run(RunSpec("run-4", "escape", maxSteps = 3))

        assertEquals(ToolStatus.ERROR, result.toolResults.single().status)
        assertFalse(Files.exists(workspace.root.parent.resolve("escape.txt")))
    }

    @Test
    fun `model failure marks the run failed`() {
        val (_, registry) = workspace()
        val result = AgentLoop(
            FakeModel(ModelReply.Failure("network", "offline")),
            ActionExecutor(registry, RecordingGate(ApprovalDecision.ALLOW_ONCE)),
            MemoryRunStore(),
        ).run(RunSpec("run-5", "fail", maxSteps = 2))

        assertEquals(RunPhase.FAILED, result.phase)
        assertEquals("network: offline", result.error)
    }

    @Test
    fun `run control stops before the next tool side effect`() {
        val (workspace, registry) = workspace()
        Files.writeString(workspace.root.resolve("input.txt"), "x")
        val model = FakeModel(
            ModelReply.Calls(listOf(ToolCall("c1", "workspace_read", mapOf("path" to "input.txt")))),
            ModelReply.Text("should not be reached"),
        )
        var checks = 0
        val result = AgentLoop(
            model,
            ActionExecutor(registry, RecordingGate(ApprovalDecision.ALLOW_ONCE)),
            MemoryRunStore(),
            control = RunControl {
                checks += 1
                checks == 1
            },
        ).run(RunSpec("run-stop", "stop", maxSteps = 4))

        assertEquals(RunPhase.INTERRUPTED, result.phase)
        assertEquals("stopped-by-user", result.error)
        assertTrue(result.toolResults.isEmpty())
        assertEquals(1, model.requests.size)
    }

    @Test
    fun `file run store survives a new instance`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-6", "persist"))
        store.transition("run-6", RunPhase.RUNNING)
        store.step("run-6", 2)

        val snapshot = FileRunStore(root).snapshot("run-6")
        assertNotNull(snapshot)
        assertEquals(RunPhase.RUNNING, snapshot?.phase)
        assertEquals(2, snapshot?.step)
    }
}
