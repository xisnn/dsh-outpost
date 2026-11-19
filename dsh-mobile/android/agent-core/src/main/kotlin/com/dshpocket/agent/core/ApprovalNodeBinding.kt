package com.dshpocket.agent.core

import java.security.MessageDigest

/**
 * P6-next candidate 3: approval node-identity binding.
 *
 * Approval already binds the tool call id and the argument digest, and
 * ScreenGuard binds the screen generation. Neither binds the NODE: after a
 * background-display loss/recovery and a fresh snapshot, the same positional
 * ordinal can resolve to a different control, so an old approval would execute
 * against an object the user never saw.
 *
 * The identity therefore excludes the ordinal and hashes exactly what the
 * approval card rendered (package + visible text/description/class/bounds/
 * flags). At execution the live node is re-resolved and compared; any
 * difference is STALE_NODE and any missing/unverifiable side is UNVERIFIABLE.
 * Refusal only - this never grants anything and never auto-re-approves.
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI; the Android layer
 * supplies the signatures at approval time and at execution time.
 */
object ApprovalNodeBinding {
    enum class Binding { ALLOW, STALE_NODE, UNVERIFIABLE }

    /** Identity of one approved element, independent of its positional ordinal. */
    fun identity(packageName: String?, sig: ScreenGuard.ElementSig): String {
        val sb = StringBuilder()
        sb.append(packageName ?: "").append('|')
            .append(sig.text).append('|')
            .append(sig.description).append('|')
            .append(sig.className).append('|')
            .append(sig.bounds).append('|')
            .append(sig.flags)
        val digest = MessageDigest.getInstance("SHA-256").digest(sb.toString().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun decision(approved: String?, live: String?): Binding {
        if (approved.isNullOrBlank()) return Binding.UNVERIFIABLE
        if (live.isNullOrBlank()) return Binding.UNVERIFIABLE
        return if (approved == live) Binding.ALLOW else Binding.STALE_NODE
    }
}
