package com.dshpocket.agent.core

import java.security.MessageDigest

/**
 * P4-0.1 P0-3A: screen-generation binding for phone actions.
 *
 * The accessibility adapter hands the model positional element ids (`n1`, `n2`,
 * ...) that only mean something inside the traversal that produced them. Before
 * this guard, tap/scroll/key/type re-resolved those ids against whatever tree
 * was live at action time: after a navigation inside the SAME package, `n5`
 * could resolve to a different control and the gesture would land there.
 *
 * The contract now is: an action may only run while the live screen still
 * matches the last snapshot that was actually shown to the model. Any change
 * (different package, different window content, lock state, sensitivity) makes
 * the published fingerprint stale and the action is refused with STALE_SCREEN
 * until the model re-snapshots. Refusal only — this never grants anything.
 *
 * Pure Kotlin so the decision logic is covered by JVM tests in CI; the
 * accessibility service supplies the fingerprints.
 */
object ScreenGuard {
    /** Identity of one snapshot element, independent of the Android node tree. */
    data class ElementSig(
        val id: String,
        val text: String,
        val description: String,
        val className: String,
        val bounds: String,
        val flags: String,
    )

    @Volatile
    private var published: String? = null

    fun fingerprint(
        packageName: String?,
        displayId: Int,
        locked: Boolean,
        sensitive: Boolean,
        elements: List<ElementSig>,
    ): String {
        val sb = StringBuilder()
        sb.append(packageName ?: "").append('|')
            .append(displayId).append('|')
            .append(locked).append('|')
            .append(sensitive)
        for (e in elements) {
            sb.append('\n')
                .append(e.id).append('|')
                .append(e.text).append('|')
                .append(e.description).append('|')
                .append(e.className).append('|')
                .append(e.bounds).append('|')
                .append(e.flags)
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(sb.toString().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** Record the fingerprint of a snapshot that was returned to the model. */
    fun publish(fingerprint: String) {
        published = fingerprint
    }

    /** True when no snapshot was published, or the live screen no longer matches it. */
    fun isStale(currentFingerprint: String): Boolean {
        val p = published ?: return true
        return p != currentFingerprint
    }

    fun publishedFingerprint(): String? = published

    /** Test/service lifecycle hook: forget the published snapshot. */
    fun reset() {
        published = null
    }
}