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
                val request = ModelRequest(messages.toList(), executor.registry.specs)
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
                        messages += AgentMessage.Tool(result.callId, result.name, content)
                    }
                }
            }
        }
        store.transition(spec.id, RunPhase.FAILED, "step-limit")
        return RunResult(spec.id, RunPhase.FAILED, null, "step-limit", messages.toList(), toolResults.toList())
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
        const val DEFAULT_SYSTEM_PROMPT =
            "You are a local phone butler. Use only the provided tools; never claim a tool succeeded unless its result says OK. " +
                "All file paths are relative to the workspace. Ask for approval through the tool layer, never bypass it."
    }
}
