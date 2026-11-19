package com.dshpocket.agent.core

/**
 * P6-next candidate 1: guarded custom-input fallback gate for phone_type.
 *
 * Non-editable custom input surfaces (WebView contenteditable, self-drawn
 * fields) used to be refused outright and never reached the clipboard/shell
 * fallbacks. A CLICKABLE non-editable node may enter a guarded fallback
 * (click to focus, re-check package/window, clipboard paste or shell input,
 * re-snapshot verification). Every refusal invariant stays: password and
 * disabled fields never enter, a window/package change aborts before any
 * write, and a field holding extra text is UNVERIFIED (never retried, so the
 * fallback cannot duplicate or clobber app-written content).
 *
 * Pure Kotlin so the contract is covered by JVM tests in CI; the accessibility
 * service performs the guarded steps and reports the mapped outcome.
 */
object TypeFallbackDecision {
    enum class Gate { USE_EDITABLE_PATH, TRY_CUSTOM_FALLBACK, REFUSE_NOT_EDITABLE, REFUSE_PASSWORD, REFUSE_DISABLED }

    enum class Match { EXACT, CONTAINS, MISMATCH }

    enum class Outcome { OK, UNVERIFIED, FAILED }

    fun gate(
        nodeEditable: Boolean,
        subtreeEditable: Boolean,
        clickable: Boolean,
        password: Boolean,
        enabled: Boolean,
    ): Gate {
        if (password) return Gate.REFUSE_PASSWORD
        if (!enabled) return Gate.REFUSE_DISABLED
        if (nodeEditable || subtreeEditable) return Gate.USE_EDITABLE_PATH
        if (clickable) return Gate.TRY_CUSTOM_FALLBACK
        return Gate.REFUSE_NOT_EDITABLE
    }

    fun outcome(match: Match, actionAccepted: Boolean): Outcome = when {
        match == Match.EXACT && actionAccepted -> Outcome.OK
        match == Match.CONTAINS -> Outcome.UNVERIFIED
        actionAccepted -> Outcome.UNVERIFIED
        else -> Outcome.FAILED
    }

    /** True when the fallback must abort before writing anything. */
    fun abort(windowUnchanged: Boolean): Boolean = !windowUnchanged
}
