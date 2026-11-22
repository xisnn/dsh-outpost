package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

    @Test
    fun `unacknowledged reconciliation survives a second cold restart until acknowledged`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-crash", "write important file"))
        store.transition("run-crash", RunPhase.RUNNING)
        store.toolStarted("run-crash", "call-1", "workspace_write", "digest-1", mayHaveSideEffect = true)

        // First startup converts RUNNING -> INTERRUPTED + requiresReconciliation = true.
        val firstStart = RunRecovery.recover(FileRunStore(root)) ?: RunRecovery.pendingReconciliation(FileRunStore(root))
        assertEquals("run-crash", firstStart?.id)

        // Second cold restart before user taps "知道了": recover() is null, but pendingReconciliation still surfaces it!
        val secondStore = FileRunStore(root)
        assertNull(RunRecovery.recover(secondStore))
        val secondPending = RunRecovery.pendingReconciliation(secondStore)
        assertEquals("run-crash", secondPending?.id)
        assertEquals(true, secondPending?.requiresReconciliation)
        assertNull(secondPending?.reconciledAt)
    }

    @Test
    fun `pendingReconciliation clears after acknowledgeReconciliation`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-ack", "tap submit"))
        store.transition("run-ack", RunPhase.RUNNING)
        store.toolStarted("run-ack", "call-1", "phone_tap", "digest-2", mayHaveSideEffect = true)

        RunRecovery.recover(store)
        assertNotNull(RunRecovery.pendingReconciliation(store))

        assertTrue(store.acknowledgeReconciliation("run-ack", at = 8_888L))
        val afterRestart = FileRunStore(root)
        assertNull(RunRecovery.pendingReconciliation(afterRestart))
        assertEquals(8_888L, afterRestart.snapshot("run-ack")?.reconciledAt)
    }

    @Test
    fun `read-only interrupted run without unknown side effects does not trigger pendingReconciliation`() {
        val root = temporary.newFolder("runs").toPath()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-ro", "read screen"))
        store.transition("run-ro", RunPhase.RUNNING)
        store.toolStarted("run-ro", "call-1", "phone_screen", "digest-3", mayHaveSideEffect = false)

        RunRecovery.recover(store)
        assertNull(RunRecovery.pendingReconciliation(FileRunStore(root)))
    }
}
