package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RunRecoveryTest {
    @Rule
    @JvmField
    val temporary = TemporaryFolder()

    @Test
    fun `startup recovery marks unknown side effect and never restores approval`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-recover", "write a file"))
        store.transition("run-recover", RunPhase.RUNNING)
        store.toolStarted(
            runId = "run-recover",
            callId = "call-1",
            toolName = "workspace_write",
            digest = "digest-1",
            mayHaveSideEffect = true,
        )

        val recovered = RunRecovery.recover(FileRunStore(root))
        assertEquals("run-recover", recovered?.id)
        assertEquals(RunPhase.INTERRUPTED, recovered?.phase)
        assertTrue(recovered?.requiresReconciliation == true)
        assertTrue(recovered?.reason?.contains("unknown") == true)
        assertEquals("STARTED", recovered?.lastToolStatus)
        assertEquals("write a file", recovered?.goal)

        // A second startup must not replay or re-mark the same run.
        assertNull(RunRecovery.recover(FileRunStore(root)))
    }

    @Test
    fun `completed run is not treated as an interrupted run`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-done", "done"))
        store.transition("run-done", RunPhase.RUNNING)
        store.transition("run-done", RunPhase.COMPLETED, "model-completed")

        assertNull(RunRecovery.recover(FileRunStore(root)))
        assertEquals(RunPhase.COMPLETED, FileRunStore(root).snapshot("run-done")?.phase)
    }

    @Test
    fun `pending approval is discarded without claiming an unknown side effect`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-approval", "write"))
        store.transition("run-approval", RunPhase.WAITING_USER)
        store.toolAwaitingApproval("run-approval", "call-1", "workspace_write", "digest", true)

        val recovered = RunRecovery.recover(FileRunStore(root))
        assertEquals(RunPhase.INTERRUPTED, recovered?.phase)
        assertEquals(false, recovered?.requiresReconciliation)
        assertTrue(recovered?.reason?.contains("approval") == true)
    }

    @Test
    fun `read-only tool interrupted is not marked as an unknown side effect`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-read", "read"))
        store.transition("run-read", RunPhase.RUNNING)
        store.toolStarted("run-read", "call-1", "workspace_read", "digest", mayHaveSideEffect = false)

        val recovered = RunRecovery.recover(FileRunStore(root))
        assertEquals(RunPhase.INTERRUPTED, recovered?.phase)
        assertEquals(false, recovered?.requiresReconciliation)
    }
}
