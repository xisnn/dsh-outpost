package com.dshpocket.agent.core

import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import kotlin.io.path.name

data class ToolOutput(
    val status: ToolStatus,
    val content: String,
)

interface AgentTool {
    val spec: ToolSpec
    val risk: ToolRisk
    fun execute(call: ToolCall): ToolOutput
}

class ToolRegistry(tools: List<AgentTool>) {
    private val byName = tools.associateBy { it.spec.name }
    val specs: List<ToolSpec> = tools.map { it.spec }

    init {
        require(byName.size == tools.size) { "duplicate tool name" }
    }

    fun find(name: String): AgentTool? = byName[name]
}

data class ApprovalRequest(
    val runId: String,
    val call: ToolCall,
    val tool: ToolSpec,
    val risk: ToolRisk,
    val digest: String,
    val reason: String,
)

enum class ApprovalDecision {
    ALLOW_ONCE,
    REJECT,
}

fun interface ApprovalGate {
    fun decide(request: ApprovalRequest): ApprovalDecision
}

/**
 * The only place a tool is allowed to run. Approval binds to the exact tool call
 * id and argument digest; a gate that answers for a different call cannot approve
 * this one because the digest/id are supplied by the executor.
 */
class ActionExecutor(
    val registry: ToolRegistry,
    private val approvals: ApprovalGate,
    /**
     * Optional defense-in-depth veto checked after the user's decision and
     * immediately before execution. It lets the Android layer fail closed when
     * the background display disappeared while the approval was pending. The
     * default keeps existing call sites and tests source-compatible.
     */
    /**
     * Optional veto checked before the approval gate. It lets the Android
     * layer reject an action that cannot be performed safely (for example a
     * background display home/recents key) without asking the user first.
     */
    private val preApproval: ((AgentTool, ToolCall) -> ToolOutput?)? = null,
    private val preExecute: ((AgentTool, ToolCall) -> ToolOutput?)? = null,
) {
    fun execute(runId: String, call: ToolCall, onExecuting: (() -> Unit)? = null): ToolResult {
        val tool = registry.find(call.name)
            ?: return ToolResult(call.id, call.name, ToolStatus.ERROR, "unknown tool: ${call.name}", digestArguments(call.arguments))
        val digest = digestArguments(call.arguments)
        val pre = preApproval?.invoke(tool, call)
        if (pre != null) return ToolResult(call.id, call.name, pre.status, pre.content, digest)
        if (tool.risk != ToolRisk.READ) {
            val decision = try {
                approvals.decide(
                    ApprovalRequest(
                        runId = runId,
                        call = call,
                        tool = tool.spec,
                        risk = tool.risk,
                        digest = digest,
                        reason = "tool ${call.name} requires approval",
                    ),
                )
            } catch (error: Exception) {
                return ToolResult(call.id, call.name, ToolStatus.ERROR, "approval unavailable: ${error.message}", digest)
            }
            if (decision != ApprovalDecision.ALLOW_ONCE) {
                return ToolResult(call.id, call.name, ToolStatus.DENIED, "approval rejected", digest)
            }
        }
        val veto = preExecute?.invoke(tool, call)
        if (veto != null) {
            return ToolResult(call.id, call.name, veto.status, veto.content, digest)
        }
        onExecuting?.invoke()
        return try {
            val output = tool.execute(call)
            ToolResult(call.id, call.name, output.status, output.content, digest)
        } catch (error: Exception) {
            ToolResult(call.id, call.name, ToolStatus.ERROR, "tool error: ${error.message}", digest)
        }
    }
}

/** Confines tools to one workspace. Resolution is lexical first, then checks existing symlinks. */
class Workspace(root: Path) {
    val root: Path = root.toAbsolutePath().normalize().also { Files.createDirectories(it) }

    fun resolve(relative: String): Path {
        require(relative.isNotBlank()) { "empty path" }
        require(!relative.startsWith("/") && !relative.startsWith("\\") && !relative.matches(Regex("^[A-Za-z]:"))) {
            "absolute path is not allowed"
        }
        val candidate = root.resolve(relative).normalize()
        require(candidate.startsWith(root)) { "path escapes workspace" }
        var current = root
        for (part in root.relativize(candidate)) {
            current = current.resolve(part)
            if (Files.exists(current) && Files.isSymbolicLink(current)) {
                throw IllegalArgumentException("symlink is not allowed")
            }
        }
        return candidate
    }
}

class WorkspaceReadTool(private val workspace: Workspace) : AgentTool {
    override val risk = ToolRisk.READ
    override val spec = ToolSpec(
        name = "workspace_read",
        description = "Read a UTF-8 text file inside the workspace.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf("path" to mapOf("type" to "string")),
            "required" to listOf("path"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val path = workspace.resolve(stringArgument(call, "path"))
        require(Files.isRegularFile(path)) { "file not found: ${call.arguments["path"]}" }
        val size = Files.size(path)
        require(size <= MAX_TEXT_BYTES) { "file is too large" }
        return ToolOutput(ToolStatus.OK, String(Files.readAllBytes(path), StandardCharsets.UTF_8))
    }
}

class WorkspaceWriteTool(private val workspace: Workspace) : AgentTool {
    override val risk = ToolRisk.WRITE
    override val spec = ToolSpec(
        name = "workspace_write",
        description = "Write a UTF-8 text file inside the workspace.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf(
                "path" to mapOf("type" to "string"),
                "content" to mapOf("type" to "string"),
            ),
            "required" to listOf("path", "content"),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val path = workspace.resolve(stringArgument(call, "path"))
        val content = stringArgument(call, "content")
        val bytes = content.toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_TEXT_BYTES) { "content is too large" }
        Files.createDirectories(path.parent)
        val temporary = Files.createTempFile(path.parent, ".agent-write-", ".tmp")
        try {
            Files.write(temporary, bytes)
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temporary)
        }
        return ToolOutput(ToolStatus.OK, "wrote ${bytes.size} bytes to ${path.name}")
    }
}

class WorkspaceListTool(private val workspace: Workspace) : AgentTool {
    override val risk = ToolRisk.READ
    override val spec = ToolSpec(
        name = "workspace_list",
        description = "List files and directories inside the workspace.",
        parameters = mapOf(
            "type" to "object",
            "properties" to mapOf("path" to mapOf("type" to "string")),
        ),
    )

    override fun execute(call: ToolCall): ToolOutput {
        val relative = (call.arguments["path"] as? String)?.takeIf { it.isNotBlank() } ?: "."
        val directory = workspace.resolve(relative)
        require(Files.isDirectory(directory)) { "not a directory: $relative" }
        val names = Files.list(directory).use { stream ->
            stream.map { it.fileName.toString() }.sorted().collect(java.util.stream.Collectors.toList())
        }
        return ToolOutput(ToolStatus.OK, names.joinToString("\n"))
    }
}

private fun stringArgument(call: ToolCall, name: String): String {
    val value = call.arguments[name]
    require(value is String) { "argument $name must be a string" }
    return value
}

private const val MAX_TEXT_BYTES = 256 * 1024
