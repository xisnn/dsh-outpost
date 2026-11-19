package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P6-next candidate 1: guarded custom-input fallback contract for phone_type.
 *
 * Non-editable custom input surfaces (WebView contenteditable, self-drawn
 * fields) were refused outright (ELEMENT_NOT_EDITABLE) and never reached the
 * clipboard/shell fallbacks. The gate below admits a CLICKABLE non-editable
 * node into a guarded fallback while keeping every refusal invariant:
 * password and disabled fields never enter it, and a window/package change
 * during the fallback aborts before any text is written.
 */
class TypeFallbackDecisionTest {
    @Test fun editableNodeUsesTheNormalSetTextPath() {
        assertEquals(
            TypeFallbackDecision.Gate.USE_EDITABLE_PATH,
            TypeFallbackDecision.gate(nodeEditable = true, subtreeEditable = false, clickable = true, password = false, enabled = true),
        )
    }

    @Test fun editableSubtreeUsesTheNormalSetTextPath() {
        assertEquals(
            TypeFallbackDecision.Gate.USE_EDITABLE_PATH,
            TypeFallbackDecision.gate(nodeEditable = false, subtreeEditable = true, clickable = true, password = false, enabled = true),
        )
    }

    @Test fun passwordNeverEntersFallback() {
        assertEquals(
            TypeFallbackDecision.Gate.REFUSE_PASSWORD,
            TypeFallbackDecision.gate(nodeEditable = true, subtreeEditable = false, clickable = true, password = true, enabled = true),
        )
        assertEquals(
            TypeFallbackDecision.Gate.REFUSE_PASSWORD,
            TypeFallbackDecision.gate(nodeEditable = false, subtreeEditable = false, clickable = true, password = true, enabled = true),
        )
    }

    @Test fun disabledNeverEntersFallback() {
        assertEquals(
            TypeFallbackDecision.Gate.REFUSE_DISABLED,
            TypeFallbackDecision.gate(nodeEditable = false, subtreeEditable = false, clickable = true, password = false, enabled = false),
        )
    }

    @Test fun nonEditableNonClickableIsRefused() {
        assertEquals(
            TypeFallbackDecision.Gate.REFUSE_NOT_EDITABLE,
            TypeFallbackDecision.gate(nodeEditable = false, subtreeEditable = false, clickable = false, password = false, enabled = true),
        )
    }

    @Test fun clickableCustomSurfaceEntersGuardedFallback() {
        assertEquals(
            TypeFallbackDecision.Gate.TRY_CUSTOM_FALLBACK,
            TypeFallbackDecision.gate(nodeEditable = false, subtreeEditable = false, clickable = true, password = false, enabled = true),
        )
    }

    @Test fun exactMatchIsOk() {
        assertEquals(TypeFallbackDecision.Outcome.OK, TypeFallbackDecision.outcome(TypeFallbackDecision.Match.EXACT, actionAccepted = true))
    }

    @Test fun containsIsUnverifiedNeverRetried() {
        assertEquals(TypeFallbackDecision.Outcome.UNVERIFIED, TypeFallbackDecision.outcome(TypeFallbackDecision.Match.CONTAINS, actionAccepted = true))
        assertEquals(TypeFallbackDecision.Outcome.UNVERIFIED, TypeFallbackDecision.outcome(TypeFallbackDecision.Match.CONTAINS, actionAccepted = false))
    }

    @Test fun mismatchWithAcceptedActionIsUnverified() {
        assertEquals(TypeFallbackDecision.Outcome.UNVERIFIED, TypeFallbackDecision.outcome(TypeFallbackDecision.Match.MISMATCH, actionAccepted = true))
    }

    @Test fun mismatchWithoutAcceptedActionFails() {
        assertEquals(TypeFallbackDecision.Outcome.FAILED, TypeFallbackDecision.outcome(TypeFallbackDecision.Match.MISMATCH, actionAccepted = false))
    }

    @Test fun windowChangeAbortsBeforeAnyWrite() {
        assertEquals(true, TypeFallbackDecision.abort(windowUnchanged = false))
    }

    @Test fun unchangedWindowProceeds() {
        assertEquals(false, TypeFallbackDecision.abort(windowUnchanged = true))
    }
}
