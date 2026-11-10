package com.dshpocket.agent.core

/**
 * Cooperative pause/stop boundary. It is checked before a model request and
 * before each tool call; blocking here is how the phone overlay pauses a run.
 * A false result means the run must stop without executing anything further.
 */
fun interface RunControl {
    fun beforeStep(): Boolean
}
