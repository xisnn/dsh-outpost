package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

class FileRunStoreTest {
    @Rule
    @JvmField
    val temporary = TemporaryFolder()

    private fun runs() = temporary.newFolder("runs").toPath()

    /**
     * Writes a state file the way [FileRunStore] would, but with caller-chosen
     * timestamps. Pruning is ordered by updatedAt, and wall-clock writes inside a
     * test all land in the same millisecond, so the order has to be pinned.
     */
    private fun writeRaw(
        root: Path,
        runId: String,
        phase: RunPhase? = RunPhase.COMPLETED,
        updatedAt: Long = 0,
        requiresReconciliation: Boolean = false,
    ) {
        val properties = Properties().apply {
            setProperty("id", runId)
            phase?.let { setProperty("phase", it.name) }
            setProperty("step", "0")
            setProperty("requiresReconciliation", requiresReconciliation.toString())
            setProperty("updatedAt", updatedAt.toString())
        }
        FileOutputStream(root.resolve("$runId.properties").toFile()).use { properties.store(it, null) }
    }

    @Test
    fun `an unparseable phase is reported unreadable instead of throwing`() {
        val root = runs()
        writeRaw(root, "run-bad", phase = null, updatedAt = 1)
        Files.writeString(root.resolve("run-worse.properties"), "phase=TELEPORTED\nupdatedAt=2\n")

        val store = FileRunStore(root)
        // write() always records a phase, so a missing or unknown value means the
        // file was truncated mid-write. Guessing an active phase here would hand
        // startup recovery a run it believes is resumable.
        for (runId in listOf("run-bad", "run-worse")) {
            val snapshot = store.snapshot(runId)
            assertEquals(RunPhase.FAILED, snapshot?.phase)
            assertEquals("run-state-unreadable", snapshot?.reason)
            assertEquals(true, snapshot?.requiresReconciliation)
        }
    }

    @Test
    fun `one unreadable run does not stop the other runs from being reconciled`() {
        val root = runs()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-live", "live"))
        store.transition("run-live", RunPhase.RUNNING)
        store.toolStarted("run-live", "call-1", "workspace_write", "digest", mayHaveSideEffect = true)
        Files.writeString(root.resolve("run-bad.properties"), "phase=TELEPORTED\n")

        // list() feeds recovery; before per-file isolation a single bad file threw
        // out of list() and every other interrupted run stayed active forever.
        val recovered = RunRecovery.recover(FileRunStore(root))
        assertEquals("run-live", recovered?.id)
        assertEquals(RunPhase.INTERRUPTED, recovered?.phase)
        assertEquals(true, recovered?.requiresReconciliation)

        val remaining = FileRunStore(root).list()
        assertEquals(2, remaining.size)
        assertEquals(RunPhase.FAILED, remaining.first { it.id == "run-bad" }.phase)
    }

    @Test
    fun `a file that is not a valid run id is skipped by list`() {
        val root = runs()
        val store = FileRunStore(root)
        store.begin(RunSpec("run-ok", "ok"))
        // fileFor() rejects this id, so snapshot() throws; list() must absorb it.
        Files.writeString(root.resolve("run#1.properties"), "phase=RUNNING\n")

        assertEquals(listOf("run-ok"), store.list().map { it.id })
    }

    @Test
    fun `pruning removes the oldest terminal runs and keeps the cap`() {
        val root = runs()
        val store = FileRunStore(root)
        val overflow = FileRunStore.MAX_RUN_FILES + 1
        for (index in 1..overflow) {
            writeRaw(root, "run-%03d".format(index), updatedAt = index.toLong())
        }
        // Still owes the user an explanation about an unknown side effect.
        writeRaw(
            root,
            "run-unknown",
            phase = RunPhase.INTERRUPTED,
            updatedAt = (overflow + 1).toLong(),
            requiresReconciliation = true,
        )

        store.begin(RunSpec("run-new", "new"))

        val remaining = FileRunStore(root).list()
        assertNull(remaining.firstOrNull { it.id == "run-001" })
        assertNotNull(remaining.firstOrNull { it.id == "run-002" })
        assertNotNull(remaining.firstOrNull { it.id == "run-%03d".format(overflow) })
        assertEquals(
            FileRunStore.MAX_RUN_FILES,
            remaining.count { it.phase in FileRunStore.TERMINAL_PHASES && !it.requiresReconciliation },
        )
        // Neither the reconciliation evidence nor the live run is prunable.
        assertEquals(true, remaining.first { it.id == "run-unknown" }.requiresReconciliation)
        assertEquals(RunPhase.QUEUED, remaining.first { it.id == "run-new" }.phase)
    }

    @Test
    fun `an unreadable run file survives pruning`() {
        val root = runs()
        val store = FileRunStore(root)
        for (index in 1..FileRunStore.MAX_RUN_FILES + 1) {
            writeRaw(root, "run-%03d".format(index), updatedAt = index.toLong())
        }
        Files.writeString(root.resolve("run-bad.properties"), "phase=TELEPORTED\n")

        store.begin(RunSpec("run-new", "new"))

        // corrupt() reports requiresReconciliation, which is what keeps it out of
        // the prunable set: deleting it would erase the only trace that something
        // went wrong.
        assertTrue(Files.exists(root.resolve("run-bad.properties")))
    }

    @Test
    fun `a store under the cap is left alone`() {
        val root = runs()
        val store = FileRunStore(root)
        for (index in 1..5) {
            store.begin(RunSpec("run-$index", "goal-$index"))
            store.transition("run-$index", RunPhase.COMPLETED)
        }

        store.begin(RunSpec("run-6", "goal-6"))

        assertEquals(6, FileRunStore(root).list().size)
    }

    @Test
    fun `non-terminal runs are never pruned however many there are`() {
        val root = runs()
        val store = FileRunStore(root)
        val overflow = FileRunStore.MAX_RUN_FILES + 1
        for (index in 1..overflow) {
            writeRaw(root, "run-%03d".format(index), phase = RunPhase.RUNNING, updatedAt = index.toLong())
        }

        store.begin(RunSpec("run-new", "new"))

        // A cap on history must never discard runs that are still in flight.
        assertEquals(overflow + 1, FileRunStore(root).list().size)
    }
}
