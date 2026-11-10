package com.dshpocket.agent

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.dshpocket.agent.core.ActionExecutor
import com.dshpocket.agent.core.AgentLoop
import com.dshpocket.agent.core.AgentMessage
import com.dshpocket.agent.core.ApprovalDecision
import com.dshpocket.agent.core.ApprovalGate
import com.dshpocket.agent.core.ApprovalRequest
import com.dshpocket.agent.core.CloudModelClient
import com.dshpocket.agent.core.FileRunStore
import com.dshpocket.agent.core.ModelClient
import com.dshpocket.agent.core.ModelConfig
import com.dshpocket.agent.core.ModelReply
import com.dshpocket.agent.core.ModelRequest
import com.dshpocket.agent.core.RunControl
import com.dshpocket.agent.core.RunObserver
import com.dshpocket.agent.core.RunPhase
import com.dshpocket.agent.core.RunRecovery
import com.dshpocket.agent.core.RunSnapshot
import com.dshpocket.agent.core.RunSpec
import com.dshpocket.agent.core.ToolCall
import com.dshpocket.agent.core.ToolOutput
import com.dshpocket.agent.core.ToolRegistry
import com.dshpocket.agent.core.ToolResult
import com.dshpocket.agent.core.ToolRisk
import com.dshpocket.agent.core.ToolStatus
import com.dshpocket.agent.core.Workspace
import com.dshpocket.agent.core.WorkspaceListTool
import com.dshpocket.agent.core.WorkspaceReadTool
import com.dshpocket.agent.core.WorkspaceWriteTool
import com.dshpocket.agent.background.BackgroundDisplayController
import com.dshpocket.agent.background.BackgroundModeStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * P6-0 process-wide owner for the self-hosted agent. The service holds the
 * foreground lifecycle; this object holds the run and its pending approval.
 * The model is deliberately a fixed demo model until P6-1 adapters land.
 */
class AgentRuntime private constructor(context: Context) {
    companion object {
        @Volatile
        private var instance: AgentRuntime? = null

        fun get(context: Context): AgentRuntime =
            instance ?: synchronized(this) {
                instance ?: AgentRuntime(context.applicationContext).also { instance = it }
            }

        private const val MAX_QUEUED_TASKS = 8
    }

    private val app = context.applicationContext
    private val workspace = Workspace(File(app.filesDir, "agent-workspace").toPath())
    private val runs = FileRunStore(File(app.filesDir, "agent-runs").toPath())
    private val memory = AgentMemoryStore(app)
    private val thread = AgentThreadStore(app)
    private val queue = ArrayDeque<QueuedTask>()
    private var recovery: RunSnapshot? = RunRecovery.recover(runs)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val lock = ReentrantLock()
    private val approvalChanged = lock.newCondition()
    private val controlChanged = lock.newCondition()

    private var runId: String? = null
    private var active = false
    private var pending: ApprovalRequest? = null
    private var decision: ApprovalDecision? = null
    private var pendingHandoff: String? = null
    private var handoffResume: Boolean? = null
    private var paused = false
    private var stopped = false
    private var backgroundLost = false
    private var finalText: String? = null
    private var lastError: String? = null
    private var fallbackPhase: String = "idle"
    @Volatile
    private var finished: (() -> Unit)? = null

    /** Set when a run ended while no service had registered a callback yet. */
    @Volatile
    private var finishUnobserved = false
    private val liveText = StringBuilder()
    private val liveEvents = mutableListOf<JSONObject>()
    private var eventSequence = 0

    private data class QueuedTask(
        val id: String,
        val goal: String,
        val config: ModelConfig,
        val backgroundExpected: Boolean,
    )

    fun setOnFinished(callback: (() -> Unit)?) {
        finished = callback
        // The bridge starts the run right after startForegroundService, so a
        // fast finish (a workspace error, or the demo model) can precede
        // onCreate. Replay it, or the service stays in the foreground with no
        // run left to report.
        if (callback != null && finishUnobserved) {
            finishUnobserved = false
            callback()
        }
    }

    /**
     * A Run must use the background screen when auto-start is on or when a
     * background display is already active. Capturing this at enqueue time
     * keeps a queued task from silently falling back to the main screen if the
     * display disappears before the task starts.
     */
    private fun expectedBackground(): Boolean =
        BackgroundModeStore(app).enabled() ||
            PhoneBridge.hasBackgroundDisplay() ||
            PhoneBridge.runUsesBackground()

    fun startDemo(): JSONObject {
        val backgroundExpected = expectedBackground()
        val id = beginRun() ?: return snapshot()
        lock.lock()
        try { queue.clear() } finally { lock.unlock() }
        try {
            val input = workspace.resolve("input.txt")
            if (!Files.exists(input)) Files.write(input, "P6_INPUT_OK\n".toByteArray(Charsets.UTF_8))
            Files.deleteIfExists(workspace.resolve("p6-demo-output.txt"))
        } catch (error: Exception) {
            finishWithFailure(id, "workspace-error: ${error.message}")
            return snapshot()
        }
        worker.execute {
            executeRun(
                id = id,
                model = DemoModel(),
                goal = "P6 demo: read input and write output",
                maxSteps = 6,
                backgroundExpected = backgroundExpected,
            )
        }
        return snapshot()
    }

    /**
     * P6-1 cloud run. The provider/model is fixed before the run starts; a
     * provider failure ends this run and is never retried against another
     * provider. The API key stays in the native Keystore-backed store.
     */
    fun startCloud(goal: String): JSONObject {
        if (goal.isBlank()) return error("EMPTY_GOAL")
        val config = AgentSettingsStore(app).modelConfig() ?: return error("MODEL_NOT_CONFIGURED")
        // Read the preference and the active display outside the lock; the
        // queued task keeps this expectation until it starts.
        val backgroundExpected = expectedBackground()
        val id: String
        lock.lock()
        try {
            if (active) {
                if (queue.size >= MAX_QUEUED_TASKS) return error("QUEUE_FULL")
                queue.addLast(
                    QueuedTask(
                        UUID.randomUUID().toString(),
                        goal.trim(),
                        config,
                        backgroundExpected,
                    ),
                )
                return snapshotLocked()
            }
            id = startRunLocked()
        } finally {
            lock.unlock()
        }
        worker.execute {
            executeRun(
                id = id,
                model = CloudModelClient(config),
                goal = goal.trim(),
                maxSteps = 12,
                recordThread = true,
                backgroundExpected = backgroundExpected,
            )
        }
        return snapshot()
    }

    private fun beginRun(): String? {
        lock.lock()
        try {
            if (active) return null
            return startRunLocked()
        } finally {
            lock.unlock()
        }
    }

    private fun startRunLocked(): String {
        val id = UUID.randomUUID().toString()
        runId = id
        active = true
        // A finish recorded for a previous run must not stop the service that
        // this run is about to ask for.
        finishUnobserved = false
        liveText.setLength(0)
        liveEvents.clear()
        eventSequence = 0
        pending = null
        decision = null
        pendingHandoff = null
        handoffResume = null
        paused = false
        stopped = false
        backgroundLost = false
        finalText = null
        lastError = null
        fallbackPhase = RunPhase.QUEUED.name.lowercase()
        return id
    }

    private fun executeRun(
        id: String,
        model: ModelClient,
        goal: String,
        maxSteps: Int,
        recordThread: Boolean = false,
        backgroundExpected: Boolean = expectedBackground(),
    ) {
        val prior = if (recordThread) thread.priorMessages() else emptyList()
        if (recordThread) thread.append("user", goal)
        var result: com.dshpocket.agent.core.RunResult? = null
        var backgroundBound = false
        try {
            val toolList = mutableListOf(
                WorkspaceReadTool(workspace),
                WorkspaceWriteTool(workspace),
                WorkspaceListTool(workspace),
            )
            if (Build.VERSION.SDK_INT >= 31 && PhoneBridge.isConnected()) {
                toolList += PhoneTools(app) { reason -> awaitHandoff(reason) }.all()
                // Keep the enqueue-time expectation. If the display is gone,
                // runBackgroundLost() becomes true and beforeStep pauses
                // before the first model request instead of using the main
                // display.
                PhoneBridge.beginRun(backgroundExpected)
                backgroundBound = true
            }
            val gate = ApprovalGate { request -> awaitApproval(request) }
            val observer = object : RunObserver {
                override fun onText(delta: String) {
                    lock.lock()
                    try {
                        if (active) liveText.append(delta)
                    } finally {
                        lock.unlock()
                    }
                }

                override fun onToolStarted(call: com.dshpocket.agent.core.ToolCall) {
                    appendEvent("tool_started", call.name, null, call.id)
                }

                override fun onToolFinished(call: com.dshpocket.agent.core.ToolCall, result: ToolResult) {
                    appendEvent("tool_finished", call.name, result.status.name, result.content.take(120))
                }
            }
            val runResult = AgentLoop(
                model,
                ActionExecutor(
                    ToolRegistry(toolList),
                    gate,
                    preApproval = { tool, call ->
                        // Shared rule with PhoneKeyTool: reject unsupported
                        // background keys before asking the user for approval.
                        if (tool.spec.name == "phone_key" &&
                            PhoneBridge.isUnsupportedBackgroundKey(
                                call.arguments["key"] as? String,
                                PhoneBridge.currentDisplayId(),
                            )
                        ) {
                            ToolOutput(ToolStatus.ERROR, "BACKGROUND_KEY_UNSUPPORTED")
                        } else {
                            null
                        }
                    },
                    preExecute = { tool, _ ->
                        // The approval may have been pending when the background
                        // display disappeared. Fail closed right before execution;
                        // the next beforeStep pauses the Run.
                        if (tool.risk == ToolRisk.PHONE && PhoneBridge.runBackgroundLost()) {
                            ToolOutput(ToolStatus.ERROR, "BACKGROUND_DISPLAY_LOST")
                        } else {
                            null
                        }
                    },
                ),
                runs,
                systemPrompt = AgentLoop.DEFAULT_SYSTEM_PROMPT + memory.promptBlock(),
                control = RunControl { beforeStep() },
                observer = observer,
            ).run(RunSpec(id, goal, maxSteps = maxSteps, priorMessages = prior))
            result = runResult
            lock.lock()
            try {
                pending = null
                pendingHandoff = null
                handoffResume = null
                decision = null
                paused = false
                backgroundLost = false
                active = false
                liveText.setLength(0)
                fallbackPhase = runResult.phase.name.lowercase()
                finalText = runResult.finalText
                lastError = runResult.error
            } finally {
                lock.unlock()
            }
        } catch (error: Exception) {
            finishWithFailure(id, "agent-error: ${error.message}")
        } finally {
            if (backgroundBound) PhoneBridge.endRun()
            if (recordThread) {
                val answer = result?.finalText
                    ?: result?.let { "任务未完成：${it.error ?: it.phase.name.lowercase()}" }
                    ?: "任务失败：${lastError ?: "未知错误"}"
                thread.append("assistant", answer)
            }
            var next: QueuedTask? = null
            lock.lock()
            try {
                if (!stopped && active.not() && queue.isNotEmpty()) {
                    val candidate = queue.removeFirst()
                    // Reuse the same reset path as a fresh run; this keeps the
                    // service alive and carries the thread into the next task.
                    runId = candidate.id
                    active = true
                    liveText.setLength(0)
                    liveEvents.clear()
                    eventSequence = 0
                    pending = null
                    decision = null
                    pendingHandoff = null
                    handoffResume = null
                    paused = false
                    backgroundLost = false
                    finalText = null
                    lastError = null
                    fallbackPhase = RunPhase.QUEUED.name.lowercase()
                    next = candidate
                }
            } finally {
                lock.unlock()
            }
            if (next != null) {
                worker.execute {
                    // Never downgrade a background expectation; upgrade it if
                    // auto-start or a display is active by the time the task
                    // actually starts.
                    val useBackground = next!!.backgroundExpected || expectedBackground()
                    executeRun(
                        id = next!!.id,
                        model = CloudModelClient(next!!.config),
                        goal = next!!.goal,
                        maxSteps = 12,
                        recordThread = true,
                        backgroundExpected = useBackground,
                    )
                }
            } else {
                if (BackgroundModeStore(app).enabled()) {
                    runCatching { BackgroundDisplayController.stopIfRunning() }
                }
                val callback = finished
                if (callback != null) main.post(callback) else finishUnobserved = true
            }
        }
    }

    /**
     * @param digest the argument digest the caller actually rendered. Providers
     *   that omit call ids get synthetic ones, and a decision can outlive the
     *   call it was made for; binding to the digest as well means a decision
     *   can never be applied to a different call that happens to share an id.
     */
    fun decide(callId: String, digest: String, allow: Boolean): JSONObject {
        lock.lock()
        try {
            val request = pending
                ?: return error("NO_PENDING_APPROVAL")
            if (request.call.id != callId || request.digest != digest) return error("STALE_APPROVAL")
            // First decision wins. The inline card and the native overlay can
            // both answer; a reject followed by a stale allow must not flip
            // the decision before awaitApproval consumes it.
            if (decision != null) return error("DECISION_IN_PROGRESS")
            // Keep the approval pending instead of silently converting the
            // user's allow into a denial. The UI disables allow and offers a
            // retry; this is the server-side backstop.
            if (allow && request.risk == ToolRisk.PHONE && PhoneBridge.runBackgroundLost()) {
                android.util.Log.w(
                    "DshAgentRuntime",
                    "approval refused: background display lost call=${request.call.id}",
                )
                return error("BACKGROUND_DISPLAY_LOST")
            }
            decision = if (allow) ApprovalDecision.ALLOW_ONCE else ApprovalDecision.REJECT
            approvalChanged.signalAll()
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    private fun appendEvent(type: String, toolName: String?, status: String?, detail: String) {
        lock.lock()
        try {
            if (!active) return
            eventSequence += 1
            liveEvents += JSONObject()
                .put("seq", eventSequence)
                .put("type", type)
                .put("toolName", toolName ?: JSONObject.NULL)
                .put("status", status ?: JSONObject.NULL)
                .put("detail", detail)
                .put("at", System.currentTimeMillis())
            while (liveEvents.size > 40) liveEvents.removeAt(0)
        } finally {
            lock.unlock()
        }
    }

    fun thread(): JSONArray = thread.json()

    fun clearThread(): JSONObject {
        thread.clear()
        return snapshot()
    }

    fun history(): JSONArray {
        val rows = try {
            runs.list().sortedByDescending { it.updatedAt }.take(30)
        } catch (_: Exception) {
            emptyList()
        }
        return JSONArray().apply {
            for (run in rows) {
                put(
                    JSONObject()
                        .put("runId", run.id)
                        .put("goal", run.goal ?: JSONObject.NULL)
                        .put("phase", run.phase.name.lowercase())
                        .put("reason", run.reason ?: JSONObject.NULL)
                        .put("resultText", run.resultText ?: JSONObject.NULL)
                        .put("requiresReconciliation", run.requiresReconciliation)
                        .put("lastToolName", run.lastToolName ?: JSONObject.NULL)
                        .put("updatedAt", run.updatedAt),
                )
            }
        }
    }

    fun dismissRecovery(): JSONObject {
        lock.lock()
        try {
            recovery = null
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    fun pause(): JSONObject {
        lock.lock()
        try {
            if (!active) return error("NO_ACTIVE_RUN")
            paused = true
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    fun resume(): JSONObject {
        lock.lock()
        try {
            if (!active) return error("NO_ACTIVE_RUN")
            paused = false
            controlChanged.signalAll()
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    fun stop(): JSONObject {
        lock.lock()
        try {
            if (!active) return error("NO_ACTIVE_RUN")
            queue.clear()
            stopped = true
            paused = false
            backgroundLost = false
            fallbackPhase = RunPhase.STOPPING.name.lowercase()
            approvalChanged.signalAll()
            controlChanged.signalAll()
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    fun resumeHandoff(): JSONObject {
        lock.lock()
        try {
            if (pendingHandoff == null) return error("NO_PENDING_HANDOFF")
            handoffResume = true
            controlChanged.signalAll()
        } finally {
            lock.unlock()
        }
        return snapshot()
    }

    fun snapshot(): JSONObject {
        lock.lock()
        return try {
            snapshotLocked()
        } finally {
            lock.unlock()
        }
    }

    private fun snapshotLocked(): JSONObject {
        val id = runId
        val run = id?.let {
            try {
                runs.snapshot(it)
            } catch (_: Exception) {
                null
            }
        }
        val phase = when {
            pending != null || pendingHandoff != null -> "waiting_user"
            stopped -> fallbackPhase
            else -> run?.phase?.name?.lowercase() ?: fallbackPhase
        }
        val result = JSONObject()
            .put("supported", true)
            .put("ok", true)
            .put("runId", id ?: JSONObject.NULL)
            .put("phase", phase)
            .put("step", run?.step ?: 0)
            .put("paused", paused)
            .put("backgroundLost", backgroundLost)
            .put("text", finalText ?: JSONObject.NULL)
            .put("error", lastError ?: JSONObject.NULL)
            .put("output", outputText())
            .put("streamText", if (active && liveText.isNotEmpty()) liveText.toString() else JSONObject.NULL)
            .put(
                "backgroundDisplayId",
                if (PhoneBridge.runUsesBackground() && PhoneBridge.runDisplayId() > 0) {
                    PhoneBridge.runDisplayId()
                } else {
                    JSONObject.NULL
                },
            )
            .put("events", JSONArray(liveEvents))
        val request = pending
        result.put(
            "pendingApproval",
            if (request == null) JSONObject.NULL else JSONObject()
                .put("callId", request.call.id)
                .put("toolName", request.call.name)
                .put("digest", request.digest)
                .put("reason", request.reason)
                .put("arguments", JSONObject(request.call.arguments))
                .put("risk", request.risk.name.lowercase())
                .put(
                    "backgroundLost",
                    request.risk == ToolRisk.PHONE && PhoneBridge.runBackgroundLost(),
                ),
        )
        result.put(
            "pendingHandoff",
            pendingHandoff?.let { JSONObject().put("reason", it) } ?: JSONObject.NULL,
        )
        result.put(
            "queue",
            JSONArray().apply {
                for (task in queue) {
                    put(JSONObject().put("id", task.id).put("goal", task.goal))
                }
            },
        )
        result.put(
            "recovery",
            recovery?.let {
                JSONObject()
                    .put("runId", it.id)
                    .put("phase", it.phase.name.lowercase())
                    .put("reason", it.reason ?: JSONObject.NULL)
                    .put("requiresReconciliation", it.requiresReconciliation)
                    .put("goal", it.goal ?: JSONObject.NULL)
                    .put("lastToolName", it.lastToolName ?: JSONObject.NULL)
                    .put("lastToolStatus", it.lastToolStatus ?: JSONObject.NULL)
                    .put("updatedAt", it.updatedAt)
            } ?: JSONObject.NULL,
        )
        return result
    }

    private fun awaitApproval(request: ApprovalRequest): ApprovalDecision {
        lock.lock()
        try {
            pending = request
            decision = null
            fallbackPhase = RunPhase.WAITING_USER.name.lowercase()
            approvalChanged.signalAll()
            while (decision == null && !stopped) {
                approvalChanged.await()
            }
            val result = if (stopped) ApprovalDecision.REJECT else (decision ?: ApprovalDecision.REJECT)
            pending = null
            decision = null
            fallbackPhase = if (stopped) RunPhase.STOPPING.name.lowercase() else RunPhase.RUNNING.name.lowercase()
            return result
        } finally {
            lock.unlock()
        }
    }

    private fun beforeStep(): Boolean {
        lock.lock()
        try {
            while (!stopped) {
                if (paused) {
                    controlChanged.await()
                    continue
                }
                if (PhoneBridge.runBackgroundLost()) {
                    backgroundLost = true
                    controlChanged.await(250, TimeUnit.MILLISECONDS)
                    continue
                }
                backgroundLost = false
                return true
            }
            return false
        } finally {
            lock.unlock()
        }
    }

    private fun awaitHandoff(reason: String): Boolean {
        lock.lock()
        try {
            pendingHandoff = reason
            handoffResume = null
            fallbackPhase = RunPhase.WAITING_USER.name.lowercase()
            approvalChanged.signalAll()
            while (handoffResume == null && !stopped) controlChanged.await()
            val resumed = !stopped && handoffResume == true
            pendingHandoff = null
            handoffResume = null
            fallbackPhase = if (stopped) RunPhase.STOPPING.name.lowercase() else RunPhase.RUNNING.name.lowercase()
            return resumed
        } finally {
            lock.unlock()
        }
    }

    private fun finishWithFailure(id: String, message: String) {
        lock.lock()
        try {
            active = false
            pending = null
            pendingHandoff = null
            handoffResume = null
            decision = null
            paused = false
            backgroundLost = false
            fallbackPhase = RunPhase.FAILED.name.lowercase()
            lastError = message
        } finally {
            lock.unlock()
        }
        try {
            runs.transition(id, RunPhase.FAILED, message)
        } catch (_: Exception) {
        }
    }

    private fun outputText(): Any {
        return try {
            val output = workspace.resolve("p6-demo-output.txt")
            if (Files.isRegularFile(output)) String(Files.readAllBytes(output), Charsets.UTF_8).take(4096) else JSONObject.NULL
        } catch (_: Exception) {
            JSONObject.NULL
        }
    }

    private fun error(code: String): JSONObject =
        JSONObject().put("supported", true).put("ok", false).put("code", code)
}

private class DemoModel : ModelClient {
    private var stage = 0

    override fun complete(request: ModelRequest): ModelReply {
        return when (stage++) {
            0 -> ModelReply.Calls(
                listOf(ToolCall("demo-read", "workspace_read", mapOf("path" to "input.txt"))),
            )

            1 -> ModelReply.Calls(
                listOf(
                    ToolCall(
                        "demo-write",
                        "workspace_write",
                        mapOf("path" to "p6-demo-output.txt", "content" to "P6_DEMO_OK\n"),
                    ),
                ),
            )

            else -> {
                val last = request.messages.filterIsInstance<AgentMessage.Tool>().lastOrNull()
                if (last?.content?.startsWith("DENIED") == true) {
                    ModelReply.Text("P6 内核演示：写入被拒绝，任务没有落盘。")
                } else {
                    ModelReply.Text("P6 内核演示完成：已读取 input.txt 并写入 p6-demo-output.txt。")
                }
            }
        }
    }
}
