package com.dshpocket.agent.core

/**
 * Minimal P6-0 loop: model -> one or more tool calls -> tool results -> model.
 * It owns no Android objects and no provider protocol; those live behind the ports.
 */
class AgentLoop(
    private val model: ModelClient,
    private val executor: ActionExecutor,
    private val store: RunStore,
    private val systemPrompt: String = DEFAULT_SYSTEM_PROMPT,
    private val control: RunControl = RunControl { true },
    private val observer: RunObserver = object : RunObserver {},
) {
    fun run(spec: RunSpec): RunResult {
        require(spec.id.isNotBlank()) { "run id required" }
        require(spec.goal.isNotBlank()) { "goal required" }
        require(spec.maxSteps > 0) { "maxSteps must be positive" }
        val messages = mutableListOf<AgentMessage>(AgentMessage.System(systemPrompt))
        messages += spec.priorMessages.filter { it is AgentMessage.User || it is AgentMessage.Assistant }
        messages += AgentMessage.User(spec.goal)
        val toolResults = mutableListOf<ToolResult>()
        store.begin(spec)
        store.transition(spec.id, RunPhase.RUNNING)

        for (step in 1..spec.maxSteps) {
            if (!control.beforeStep()) return interrupted(spec, messages, toolResults)
            store.step(spec.id, step)
            val reply = try {
                val request = ModelRequest(compact(messages), executor.registry.specs)
                if (model is StreamingModelClient) {
                    model.complete(request) { observer.onText(it) }
                } else {
                    model.complete(request)
                }
            } catch (error: Exception) {
                store.transition(spec.id, RunPhase.FAILED, "model-error")
                return RunResult(spec.id, RunPhase.FAILED, null, "model-error: ${error.message}", messages.toList(), toolResults.toList())
            }
            when (reply) {
                is ModelReply.Text -> {
                    messages += AgentMessage.Assistant(reply.text)
                    store.setResult(spec.id, reply.text)
                    store.transition(spec.id, RunPhase.COMPLETED, "model-completed")
                    return RunResult(spec.id, RunPhase.COMPLETED, reply.text, null, messages.toList(), toolResults.toList())
                }

                is ModelReply.Failure -> {
                    store.transition(spec.id, RunPhase.FAILED, reply.code)
                    return RunResult(spec.id, RunPhase.FAILED, null, "${reply.code}: ${reply.message}", messages.toList(), toolResults.toList())
                }

                is ModelReply.Calls -> {
                    if (reply.calls.isEmpty()) {
                        store.transition(spec.id, RunPhase.FAILED, "empty-tool-calls")
                        return RunResult(spec.id, RunPhase.FAILED, null, "empty-tool-calls", messages.toList(), toolResults.toList())
                    }
                    messages += AgentMessage.Assistant(reply.text, reply.calls)
                    for (call in reply.calls) {
                        if (!control.beforeStep()) return interrupted(spec, messages, toolResults)
                        val tool = executor.registry.find(call.name)
                        val digest = digestArguments(call.arguments)
                        val mayHaveSideEffect = tool != null && tool.risk != ToolRisk.READ
                        if (mayHaveSideEffect) {
                            store.toolAwaitingApproval(spec.id, call.id, call.name, digest, true)
                        } else {
                            store.toolStarted(spec.id, call.id, call.name, digest, false)
                        }
                        observer.onToolStarted(call)
                        val result = executor.execute(spec.id, call) {
                            store.toolStarted(spec.id, call.id, call.name, digest, mayHaveSideEffect)
                        }
                        observer.onToolFinished(call, result)
                        store.toolFinished(spec.id, call.id, result.status.name)
                        toolResults += result
                        val content = when (result.status) {
                            ToolStatus.OK -> result.content
                            ToolStatus.DENIED -> "DENIED: ${result.content}"
                            ToolStatus.ERROR -> "ERROR: ${result.content}"
                        }
                        messages += AgentMessage.Tool(result.callId, result.name, clip(content))
                    }
                }
            }
        }
        store.transition(spec.id, RunPhase.FAILED, "step-limit")
        return RunResult(spec.id, RunPhase.FAILED, null, "step-limit", messages.toList(), toolResults.toList())
    }

    /**
     * Only the model request is trimmed. [RunResult.toolResults] keeps every
     * full payload, so the UI and the run store still see what really came back.
     */
    private fun clip(content: String): String =
        if (content.length <= MAX_TOOL_RESULT_CHARS) {
            content
        } else {
            content.take(MAX_TOOL_RESULT_CHARS) +
                "\n…[truncated ${content.length - MAX_TOOL_RESULT_CHARS} chars; re-read a narrower range if you need more]"
        }

    /**
     * Tool results accumulate for the whole run, and a single workspace_read can
     * return hundreds of KB. Without aging, a long run overflows the provider
     * context and dies with a protocol error instead of finishing. Call ids and
     * names are preserved so providers that pair tool calls with results by id
     * still see a well-formed transcript.
     */
    private fun compact(messages: List<AgentMessage>): List<AgentMessage> {
        val stale = messages.indices
            .filter { messages[it] is AgentMessage.Tool }
            .dropLast(RECENT_TOOL_RESULTS)
            .toSet()
        if (stale.isEmpty()) return messages.toList()
        return messages.mapIndexed { index, message ->
            if (index !in stale || message !is AgentMessage.Tool) {
                message
            } else {
                AgentMessage.Tool(
                    message.callId,
                    message.name,
                    "[earlier ${message.name} result omitted to fit the context window]",
                )
            }
        }
    }

    private fun interrupted(
        spec: RunSpec,
        messages: List<AgentMessage>,
        toolResults: List<ToolResult>,
    ): RunResult {
        store.transition(spec.id, RunPhase.INTERRUPTED, "stopped-by-user")
        return RunResult(
            spec.id,
            RunPhase.INTERRUPTED,
            null,
            "stopped-by-user",
            messages,
            toolResults,
        )
    }

    companion object {
        /** workspace_read alone can return 256KB; one result must not own the window. */
        const val MAX_TOOL_RESULT_CHARS = 16_000

        /** Tool results kept verbatim; older ones are replaced by a placeholder. */
        const val RECENT_TOOL_RESULTS = 4

        const val DEFAULT_SYSTEM_PROMPT =
            "You are a local phone butler. Use only the provided tools; never claim a tool succeeded unless its result says OK. " +
                "All file paths are relative to the workspace. Ask for approval through the tool layer, never bypass it."
    }
}
