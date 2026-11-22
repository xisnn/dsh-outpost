package com.dshpocket.agent.core

/** Live progress boundary for the UI; it never changes execution semantics. */
interface RunObserver {
    fun onStepStarted(step: Int) {}
    fun onText(delta: String) {}
    fun onToolStarted(call: ToolCall) {}
    fun onToolFinished(call: ToolCall, result: ToolResult) {}
}
