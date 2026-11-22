package com.dshpocket.agent.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.file.Files
import java.util.Properties

class StorageMigratorTest {
    @Rule
    @JvmField
    val temporary = TemporaryFolder()

    private fun root() = temporary.newFolder("files").toPath()

    @Test
    fun `fresh empty directory initializes v2 manifest without creating backup`() {
        val dir = root()

        val report = StorageMigrator.migrateIfNeeded(dir, now = 1_000L)

        assertEquals(StorageMigrator.MigrationStatus.UP_TO_DATE, report.status)
        assertEquals(2, report.fromVersion)
        assertEquals(2, report.toVersion)
        assertNull(report.backupPath)
        assertTrue(Files.isRegularFile(dir.resolve(StorageMigrator.MANIFEST_FILE)))
        assertFalse(Files.exists(dir.resolve(StorageMigrator.BACKUPS_DIR)))
    }

    @Test
    fun `v1 storage upgrades losslessly to v2 with pre-migration backup`() {
        val dir = root()
        val memV1 = """
            {"version":1,"entries":[{"id":"m1","key":"语言","value":"用中文回答","createdAt":100,"updatedAt":200}]}
        """.trimIndent()
        val threadV1 = """
            {"messages":[{"role":"user","text":"打开设置","at":300},{"role":"assistant","text":"已打开","at":400}]}
        """.trimIndent()
        Files.writeString(dir.resolve(StorageMigrator.MEMORY_FILE), memV1)
        Files.writeString(dir.resolve(StorageMigrator.THREAD_FILE), threadV1)
        val runsDir = dir.resolve(StorageMigrator.RUNS_DIR).also { Files.createDirectories(it) }
        val props = Properties().apply {
            setProperty("id", "run-1")
            setProperty("phase", "COMPLETED")
            setProperty("step", "2")
            setProperty("requiresReconciliation", "false")
            setProperty("updatedAt", "500")
            setProperty("goal", "打开设置")
        }
        FileOutputStream(runsDir.resolve("run-1.properties").toFile()).use { props.store(it, null) }

        val report = StorageMigrator.migrateIfNeeded(dir, now = 2_000L)

        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, report.status)
        assertEquals(1, report.fromVersion)
        assertEquals(2, report.toVersion)
        assertNotNull(report.backupPath)

        // Pre-migration backup holds verbatim v1 copies.
        val backup = dir.resolve(report.backupPath!!)
        assertEquals(memV1, Files.readString(backup.resolve(StorageMigrator.MEMORY_FILE)))
        assertEquals(threadV1, Files.readString(backup.resolve(StorageMigrator.THREAD_FILE)))
        assertTrue(Files.isRegularFile(backup.resolve("agent-runs/run-1.properties")))

        // Memory upgraded to v2 with defaults.
        val memJson = Json.parseToJsonElement(Files.readString(dir.resolve(StorageMigrator.MEMORY_FILE))).jsonObject
        assertEquals(2, memJson["version"]!!.jsonPrimitive.int)
        val memEntry = memJson["entries"]!!.jsonArray.single().jsonObject
        assertEquals("fact", memEntry["kind"]!!.jsonPrimitive.content)
        assertEquals(false, memEntry["pinned"]!!.jsonPrimitive.boolean)
        assertEquals(true, memEntry["enabled"]!!.jsonPrimitive.boolean)
        assertEquals(1, memEntry["revision"]!!.jsonPrimitive.int)

        // Thread wrapped into default multi-session v2.
        val thrJson = Json.parseToJsonElement(Files.readString(dir.resolve(StorageMigrator.THREAD_FILE))).jsonObject
        assertEquals(2, thrJson["version"]!!.jsonPrimitive.int)
        assertEquals("default", thrJson["activeSessionId"]!!.jsonPrimitive.content)
        val sessions = thrJson["sessions"]!!.jsonArray
        assertEquals(1, sessions.size)
        val defaultSess = sessions.single().jsonObject
        assertEquals("默认对话", defaultSess["title"]!!.jsonPrimitive.content)
        assertEquals(2, defaultSess["messages"]!!.jsonArray.size)
        assertEquals(300L, defaultSess["createdAt"]!!.jsonPrimitive.long)
        assertEquals(400L, defaultSess["updatedAt"]!!.jsonPrimitive.long)

        // Run properties stamped with schemaVersion=2 & createdAt=updatedAt.
        val upgradedProps = Properties()
        FileInputStream(runsDir.resolve("run-1.properties").toFile()).use { upgradedProps.load(it) }
        assertEquals("2", upgradedProps.getProperty("schemaVersion"))
        assertEquals("500", upgradedProps.getProperty("createdAt"))
    }

    @Test
    fun `second call after migration is idempotent and does not duplicate backups`() {
        val dir = root()
        Files.writeString(dir.resolve(StorageMigrator.MEMORY_FILE), """{"version":1,"entries":[]}""")

        val first = StorageMigrator.migrateIfNeeded(dir, now = 1_000L)
        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, first.status)

        val second = StorageMigrator.migrateIfNeeded(dir, now = 2_000L)
        assertEquals(StorageMigrator.MigrationStatus.UP_TO_DATE, second.status)
        assertEquals(1, Files.list(dir.resolve(StorageMigrator.BACKUPS_DIR)).use { it.count().toInt() })
    }

    @Test
    fun `higher disk schema version fails closed without touching files`() {
        val dir = root()
        val futureManifest = """{"schemaVersion":99,"migratedAt":9000}"""
        Files.writeString(dir.resolve(StorageMigrator.MANIFEST_FILE), futureManifest)
        val untouchedThread = """{"version":99,"sessions":[]}"""
        Files.writeString(dir.resolve(StorageMigrator.THREAD_FILE), untouchedThread)

        val report = StorageMigrator.migrateIfNeeded(dir, now = 3_000L)

        assertEquals(StorageMigrator.MigrationStatus.DOWNGRADE_BLOCKED, report.status)
        assertEquals(99, report.fromVersion)
        assertTrue(report.error?.contains("STORAGE_DOWNGRADE_BLOCKED") == true)
        assertEquals(futureManifest, Files.readString(dir.resolve(StorageMigrator.MANIFEST_FILE)))
        assertEquals(untouchedThread, Files.readString(dir.resolve(StorageMigrator.THREAD_FILE)))
    }

    @Test
    fun `corrupt memory and thread json files are quarantined rather than wiped`() {
        val dir = root()
        Files.writeString(dir.resolve(StorageMigrator.MEMORY_FILE), "{not valid json")
        Files.writeString(dir.resolve(StorageMigrator.THREAD_FILE), "[]")

        val report = StorageMigrator.migrateIfNeeded(dir, now = 4_000L)

        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, report.status)
        assertEquals(2, report.quarantinedFiles.size)
        assertTrue(report.quarantinedFiles.any { it.startsWith("agent-memory.json.corrupt.") })
        assertTrue(report.quarantinedFiles.any { it.startsWith("agent-thread.json.corrupt.") })
        assertFalse(Files.exists(dir.resolve(StorageMigrator.MEMORY_FILE)))
        assertFalse(Files.exists(dir.resolve(StorageMigrator.THREAD_FILE)))
        assertTrue(report.warnings.isNotEmpty())
    }

    @Test
    fun `unreadable run properties stay untouched for FileRunStore isolation`() {
        val dir = root()
        val runsDir = dir.resolve(StorageMigrator.RUNS_DIR).also { Files.createDirectories(it) }
        val badRun = runsDir.resolve("run-bad.properties")
        Files.writeString(badRun, "phase=TELEPORTED\nupdatedAt=10\n")

        val report = StorageMigrator.migrateIfNeeded(dir, now = 5_000L)

        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, report.status)
        assertEquals("phase=TELEPORTED\nupdatedAt=10\n", Files.readString(badRun))
        val snap = FileRunStore(runsDir).snapshot("run-bad")
        assertEquals(RunPhase.FAILED, snap?.phase)
        assertEquals(true, snap?.requiresReconciliation)
    }

    @Test
    fun `duplicate memory keys from legacy edit bug are deduplicated keeping latest updatedAt`() {
        val dir = root()
        val legacyDup = """
            {
              "version": 1,
              "entries": [
                {"id":"old","key":"城市","value":"北京","createdAt":100,"updatedAt":100},
                {"id":"new","key":"城市","value":"上海","createdAt":100,"updatedAt":500}
              ]
            }
        """.trimIndent()
        Files.writeString(dir.resolve(StorageMigrator.MEMORY_FILE), legacyDup)

        val report = StorageMigrator.migrateIfNeeded(dir, now = 6_000L)

        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, report.status)
        val memJson = Json.parseToJsonElement(Files.readString(dir.resolve(StorageMigrator.MEMORY_FILE))).jsonObject
        val entries = memJson["entries"]!!.jsonArray
        assertEquals(1, entries.size)
        assertEquals("上海", entries.single().jsonObject["value"]!!.jsonPrimitive.content)
        assertTrue(report.warnings.any { it.contains("重名记忆") })
    }

    @Test
    fun `retry after crash before manifest commit stays idempotent and avoids double-wrapping sessions`() {
        val dir = root()
        // Simulate v2 thread/memory already written on disk without manifest committed yet.
        val v2Thread = """
            {"version":2,"activeSessionId":"s2","sessions":[{"id":"s2","title":"工作","createdAt":10,"updatedAt":20,"messages":[{"role":"user","text":"hello","at":20}]}]}
        """.trimIndent()
        Files.writeString(dir.resolve(StorageMigrator.THREAD_FILE), v2Thread)

        val report = StorageMigrator.migrateIfNeeded(dir, now = 7_000L)

        assertEquals(StorageMigrator.MigrationStatus.MIGRATED, report.status)
        val thrJson = Json.parseToJsonElement(Files.readString(dir.resolve(StorageMigrator.THREAD_FILE))).jsonObject
        assertEquals("s2", thrJson["activeSessionId"]!!.jsonPrimitive.content)
        assertEquals(1, thrJson["sessions"]!!.jsonArray.size)
        assertEquals("工作", thrJson["sessions"]!!.jsonArray.single().jsonObject["title"]!!.jsonPrimitive.content)
    }
}
