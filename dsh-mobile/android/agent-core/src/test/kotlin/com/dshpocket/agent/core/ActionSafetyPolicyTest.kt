package com.dshpocket.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionSafetyPolicyTest {
    private class StubTool(
        name: String,
        override val risk: ToolRisk,
        private val output: ToolOutput = ToolOutput(ToolStatus.OK, "executed"),
    ) : AgentTool {
        var executed = false
        override val spec = ToolSpec(name, "stub $name")
        override fun execute(call: ToolCall): ToolOutput {
            executed = true
            return output
        }
    }

    @Test
    fun `chinese payment buttons are hard denied on phone tap and type`() {
        for (label in listOf("立即支付", "确认付款 ¥99", "转账给好友", "发红包", "去结算")) {
            val tapVerdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_tap",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n1"),
                    screenPackage = "com.tencent.mm",
                    targetText = label,
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.HARD_DENY, tapVerdict.tier)
            assertEquals("PAYMENT_HARD_DENIED", tapVerdict.code)

            val typeVerdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_type",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n2", "text" to "100"),
                    screenPackage = "com.tencent.mm",
                    targetDescription = label,
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.HARD_DENY, typeVerdict.tier)
        }
    }

    @Test
    fun `english payment buttons are hard denied without breaking non-payment words`() {
        for (label in listOf("Pay", "Pay $9.99", "Checkout", "Buy Now", "Purchase", "Click to pay!")) {
            val verdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_tap",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n1"),
                    screenPackage = "com.example.shop",
                    targetText = label,
                ),
            )
            assertEquals("expected HARD_DENY for $label", ActionSafetyPolicy.Tier.HARD_DENY, verdict.tier)
        }

        for (benign in listOf("Inspect payload", "Shipping address", "Display settings", "Replay audio", "Buyers guide")) {
            val verdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_tap",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n1"),
                    screenPackage = "com.example.shop",
                    targetText = benign,
                ),
            )
            assertEquals("expected REQUIRE_APPROVAL (not HARD_DENY) for $benign", ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, verdict.tier)
        }
    }

    @Test
    fun `dedicated payment and banking packages are hard denied`() {
        for (pkg in listOf("com.eg.android.AlipayGphone", "com.unionpay", "cmb.pb")) {
            val openVerdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_open",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("package" to pkg),
                    targetPackage = pkg,
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.HARD_DENY, openVerdict.tier)
            assertEquals("PAYMENT_HARD_DENIED", openVerdict.code)

            val tapVerdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_tap",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n1"),
                    screenPackage = pkg,
                    targetText = "首页",
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.HARD_DENY, tapVerdict.tier)
        }
    }

    @Test
    fun `general messaging and shopping apps remain openable while sensitive settings require approval`() {
        for (pkg in listOf("com.tencent.mm", "com.android.contacts", "com.taobao.taobao")) {
            val verdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_open",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("package" to pkg),
                    targetPackage = pkg,
                    sensitivePackage = false,
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.AUTONOMOUS, verdict.tier)
        }

        val settingsVerdict = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_open",
                risk = ToolRisk.PHONE,
                arguments = mapOf("package" to "com.android.settings"),
                targetPackage = "com.android.settings",
                sensitivePackage = true,
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, settingsVerdict.tier)
    }

    @Test
    fun `read tools phone scroll and nav keys are autonomous while unknown keys require approval`() {
        val readVerdict = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(toolName = "phone_screen", risk = ToolRisk.READ),
        )
        assertEquals(ActionSafetyPolicy.Tier.AUTONOMOUS, readVerdict.tier)

        val scrollVerdict = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_scroll",
                risk = ToolRisk.PHONE,
                arguments = mapOf("direction" to "down"),
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.AUTONOMOUS, scrollVerdict.tier)

        for (key in listOf("back", "home", "recents", "BACK")) {
            val keyVerdict = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_key",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("key" to key),
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.AUTONOMOUS, keyVerdict.tier)
        }

        val unknownKey = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_key",
                risk = ToolRisk.PHONE,
                arguments = mapOf("key" to "power"),
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, unknownKey.tier)
    }

    @Test
    fun `phone tap requires approval for normal outward and unlabeled icon targets`() {
        val normal = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_tap",
                risk = ToolRisk.PHONE,
                arguments = mapOf("element" to "n1"),
                targetText = "详情",
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, normal.tier)
        assertEquals("TAP_APPROVAL", normal.code)

        for (outward in listOf("发送", "Send", "发布动态", "Forward")) {
            val v = ActionSafetyPolicy.evaluate(
                ActionSafetyPolicy.ActionContext(
                    toolName = "phone_tap",
                    risk = ToolRisk.PHONE,
                    arguments = mapOf("element" to "n2"),
                    targetText = outward,
                ),
            )
            assertEquals(ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, v.tier)
            assertEquals("OUTWARD_ACTION_APPROVAL", v.code)
        }

        // Icon-only / unreadable button must fail closed to REQUIRE_APPROVAL.
        val iconOnly = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_tap",
                risk = ToolRisk.PHONE,
                arguments = mapOf("element" to "n3"),
                targetText = "",
                targetDescription = "",
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.REQUIRE_APPROVAL, iconOnly.tier)
    }

    @Test
    fun `phone type workspace write and unknown dangerous tools require approval`() {
        assertEquals(
            ActionSafetyPolicy.Tier.REQUIRE_APPROVAL,
            ActionSafetyPolicy.evaluate(ActionSafetyPolicy.ActionContext("phone_type", ToolRisk.PHONE)).tier,
        )
        assertEquals(
            ActionSafetyPolicy.Tier.REQUIRE_APPROVAL,
            ActionSafetyPolicy.evaluate(ActionSafetyPolicy.ActionContext("workspace_write", ToolRisk.WRITE)).tier,
        )
        assertEquals(
            ActionSafetyPolicy.Tier.REQUIRE_APPROVAL,
            ActionSafetyPolicy.evaluate(ActionSafetyPolicy.ActionContext("future_dangerous_tool", ToolRisk.DANGEROUS)).tier,
        )
    }

    @Test
    fun `payment screen sensitive reason triggers hard deny on tap and type`() {
        val verdict = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_tap",
                risk = ToolRisk.PHONE,
                arguments = mapOf("element" to "n1"),
                screenPackage = "com.tencent.mm",
                targetText = "确认",
                screenSensitiveReason = "sensitive payment screen",
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.HARD_DENY, verdict.tier)
        assertEquals("PAYMENT_HARD_DENIED", verdict.code)
    }

    @Test
    fun `phone handoff is never blocked by payment hard deny`() {
        val verdict = ActionSafetyPolicy.evaluate(
            ActionSafetyPolicy.ActionContext(
                toolName = "phone_handoff",
                risk = ToolRisk.READ,
                screenPackage = "com.eg.android.AlipayGphone",
            ),
        )
        assertEquals(ActionSafetyPolicy.Tier.AUTONOMOUS, verdict.tier)
    }

    @Test
    fun `action executor hard deny refuses without calling approval gate or tool`() {
        val tool = StubTool("phone_tap", ToolRisk.PHONE)
        var approvalAsked = false
        val executor = ActionExecutor(
            ToolRegistry(listOf(tool)),
            ApprovalGate {
                approvalAsked = true
                ApprovalDecision.ALLOW_ONCE
            },
            safetyPolicy = { _, _ ->
                ActionSafetyPolicy.Verdict(
                    ActionSafetyPolicy.Tier.HARD_DENY,
                    "PAYMENT_HARD_DENIED",
                    "payment action is hard-denied",
                )
            },
        )

        val result = executor.execute("run-1", ToolCall("c1", "phone_tap", mapOf("element" to "n1")))
        assertEquals(ToolStatus.DENIED, result.status)
        assertTrue(result.content.startsWith("PAYMENT_HARD_DENIED:"))
        assertFalse(approvalAsked)
        assertFalse(tool.executed)
    }

    @Test
    fun `action executor autonomous skips approval gate but still enforces preExecute veto`() {
        val tool = StubTool("phone_scroll", ToolRisk.PHONE)
        var approvalAsked = false
        var block = true
        val executor = ActionExecutor(
            ToolRegistry(listOf(tool)),
            ApprovalGate {
                approvalAsked = true
                ApprovalDecision.REJECT
            },
            preExecute = { _, _ ->
                if (block) ToolOutput(ToolStatus.ERROR, "BACKGROUND_DISPLAY_LOST") else null
            },
            safetyPolicy = { _, _ ->
                ActionSafetyPolicy.Verdict(
                    ActionSafetyPolicy.Tier.AUTONOMOUS,
                    "BROWSE_AUTONOMOUS",
                    "browsing scroll is autonomous",
                )
            },
        )

        val vetoed = executor.execute("run-1", ToolCall("c1", "phone_scroll", mapOf("direction" to "down")))
        assertEquals(ToolStatus.ERROR, vetoed.status)
        assertEquals("BACKGROUND_DISPLAY_LOST", vetoed.content)
        assertFalse(approvalAsked)
        assertFalse(tool.executed)

        block = false
        val ok = executor.execute("run-1", ToolCall("c2", "phone_scroll", mapOf("direction" to "down")))
        assertEquals(ToolStatus.OK, ok.status)
        assertFalse(approvalAsked)
        assertTrue(tool.executed)
    }

    @Test
    fun `action executor require approval invokes approval gate with policy reason`() {
        val tool = StubTool("phone_tap", ToolRisk.PHONE)
        val seen = mutableListOf<ApprovalRequest>()
        val executor = ActionExecutor(
            ToolRegistry(listOf(tool)),
            ApprovalGate { req ->
                seen += req
                ApprovalDecision.ALLOW_ONCE
            },
            safetyPolicy = { _, _ ->
                ActionSafetyPolicy.Verdict(
                    ActionSafetyPolicy.Tier.REQUIRE_APPROVAL,
                    "OUTWARD_ACTION_APPROVAL",
                    "outward-sending or destructive action requires user approval",
                )
            },
        )

        val result = executor.execute("run-1", ToolCall("c1", "phone_tap", mapOf("element" to "n1")))
        assertEquals(ToolStatus.OK, result.status)
        assertEquals(1, seen.size)
        assertEquals("outward-sending or destructive action requires user approval", seen[0].reason)
        assertTrue(tool.executed)
    }
}
