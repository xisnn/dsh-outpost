package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * P6-next candidate 3: approval node-identity binding contract.
 *
 * The approval card renders positional element ids; after a background-display
 * loss/recovery the same ordinal can resolve to a DIFFERENT node. Binding the
 * decision to the argument digest alone therefore approves the wrong object.
 * These tests pin the pure decision: identity excludes the ordinal, includes
 * everything the user actually saw, and any missing/unverifiable side refuses.
 * Refusal only - this never grants anything.
 */
class ApprovalNodeBindingTest {
    private fun sig(id: String = "n1", text: String = "Search", bounds: String = "Rect(0, 0 - 100, 40)") =
        ScreenGuard.ElementSig(
            id = id,
            text = text,
            description = "search field",
            className = "android.widget.EditText",
            bounds = bounds,
            flags = "truefalsetruefalse",
        )

    @Test fun identityIgnoresThePositionalOrdinal() {
        assertEquals(
            ApprovalNodeBinding.identity("com.app", sig(id = "n1")),
            ApprovalNodeBinding.identity("com.app", sig(id = "n7")),
        )
    }

    @Test fun identityChangesWithVisibleText() {
        assertNotEquals(
            ApprovalNodeBinding.identity("com.app", sig(text = "Search")),
            ApprovalNodeBinding.identity("com.app", sig(text = "Delete account")),
        )
    }

    @Test fun identityChangesWithBounds() {
        assertNotEquals(
            ApprovalNodeBinding.identity("com.app", sig(bounds = "Rect(0, 0 - 100, 40)")),
            ApprovalNodeBinding.identity("com.app", sig(bounds = "Rect(0, 900 - 100, 940)")),
        )
    }

    @Test fun identityChangesWithPackage() {
        assertNotEquals(
            ApprovalNodeBinding.identity("com.app", sig()),
            ApprovalNodeBinding.identity("com.evil", sig()),
        )
    }

    @Test fun equalIdentityAllows() {
        val a = ApprovalNodeBinding.identity("com.app", sig())
        assertEquals(ApprovalNodeBinding.Binding.ALLOW, ApprovalNodeBinding.decision(a, a))
    }

    @Test fun differentIdentityIsStaleNode() {
        val a = ApprovalNodeBinding.identity("com.app", sig())
        val b = ApprovalNodeBinding.identity("com.app", sig(text = "Other control"))
        assertEquals(ApprovalNodeBinding.Binding.STALE_NODE, ApprovalNodeBinding.decision(a, b))
    }

    @Test fun missingApprovedIdentityRefuses() {
        val live = ApprovalNodeBinding.identity("com.app", sig())
        assertEquals(ApprovalNodeBinding.Binding.UNVERIFIABLE, ApprovalNodeBinding.decision(null, live))
        assertEquals(ApprovalNodeBinding.Binding.UNVERIFIABLE, ApprovalNodeBinding.decision("", live))
    }

    @Test fun missingLiveIdentityRefuses() {
        val approved = ApprovalNodeBinding.identity("com.app", sig())
        assertEquals(ApprovalNodeBinding.Binding.UNVERIFIABLE, ApprovalNodeBinding.decision(approved, null))
        assertEquals(ApprovalNodeBinding.Binding.UNVERIFIABLE, ApprovalNodeBinding.decision(approved, " "))
    }

    @Test fun bothMissingRefuses() {
        assertEquals(ApprovalNodeBinding.Binding.UNVERIFIABLE, ApprovalNodeBinding.decision(null, null))
    }
}
