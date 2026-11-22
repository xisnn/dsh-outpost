package com.dshpocket.agent.core

/**
 * Rurea C2 three-tier product safety policy (pure JVM, covered by CI tests):
 *  1. HARD_DENY (no approval channel): payment and financial actions/apps.
 *  2. AUTONOMOUS: information gathering (read tools, scroll, nav keys, opening
 *     non-sensitive non-payment apps).
 *  3. REQUIRE_APPROVAL: tap, text input, workspace write, sensitive open, and
 *     any unknown/unlabeled action (strict fail-closed).
 */
object ActionSafetyPolicy {
    enum class Tier {
        HARD_DENY,
        REQUIRE_APPROVAL,
        AUTONOMOUS,
    }

    data class Verdict(
        val tier: Tier,
        val code: String,
        val reason: String,
    )

    data class ActionContext(
        val toolName: String,
        val risk: ToolRisk,
        val arguments: Map<String, Any?> = emptyMap(),
        val targetPackage: String? = null,
        val screenPackage: String? = null,
        val targetText: String? = null,
        val targetDescription: String? = null,
        val screenSensitiveReason: String? = null,
        val sensitivePackage: Boolean = false,
    )

    // Dedicated payment/banking apps only; general messaging/shopping apps
    // (such as WeChat or Taobao) allow browsing and are guarded at element/screen level.
    private val PAYMENT_PACKAGES = setOf(
        "com.eg.android.AlipayGphone",
        "com.unionpay",
        "com.google.android.apps.walletnfcrel",
        "com.google.android.apps.nbu.paisa.user",
        "com.paypal.android.p2pmobile",
        "com.icbc",
        "com.ccb.longzhifu",
        "com.chinamworld.main",
        "com.android.bankabc",
        "com.chinamworld.bocmbci",
        "cmb.pb",
        "com.pingan.paces.ccms",
        "com.bankcomm.Bankcomm",
    )

    private val PAYMENT_PREFIX_KEYWORDS = listOf(
        "支付", "付款", "立即支付", "确认支付", "去付款", "去结算", "结算", "下单",
        "立即购买", "确认购买", "购买", "充值", "转账", "汇款", "发红包", "红包",
        "打赏", "买单", "免密", "提现", "还款", "收银台", "钱包付款", "花呗", "白条",
        "payment", "checkout", "purchase", "buy now", "place order", "pay now",
        "pay order", "bank transfer", "wire transfer", "money transfer", "donate",
        "recharge", "top up", "withdraw", "repay", "billing", "alipay",
        "wechat pay", "apple pay", "google pay",
    )

    private val PAYMENT_EXACT_LATIN_KEYWORDS = listOf("pay", "buy")

    private val OUTWARD_KEYWORDS = listOf(
        "发送", "发出", "发布", "发表", "提交", "分享", "转发", "评论", "回复",
        "呼叫", "拨打", "删除", "卸载", "退出登录", "授权", "同意并继续",
        "send", "post", "publish", "submit", "share", "forward", "reply",
        "delete", "uninstall", "authorize",
    )

    private val NAV_KEYS = setOf("back", "home", "recents")

    fun isPaymentPackage(packageName: String?): Boolean {
        val pkg = packageName?.trim()?.takeIf { it.isNotEmpty() } ?: return false
        return PAYMENT_PACKAGES.any { known ->
            pkg.equals(known, ignoreCase = true) || pkg.startsWith("$known.", ignoreCase = true)
        }
    }

    fun isPaymentText(value: String?): Boolean {
        if (value.isNullOrBlank()) return false
        return SensitiveWordMatch.anySensitive(value, PAYMENT_PREFIX_KEYWORDS) ||
            PAYMENT_EXACT_LATIN_KEYWORDS.any { SensitiveWordMatch.matchesExactWord(value, it) }
    }

    fun isOutwardText(value: String?): Boolean {
        if (value.isNullOrBlank()) return false
        return SensitiveWordMatch.anySensitive(value, OUTWARD_KEYWORDS)
    }

    fun evaluate(ctx: ActionContext): Verdict {
        // Tier 1: payment hard-deny takes priority over every tool except user handoff.
        if (ctx.toolName != "phone_handoff") {
            if (isPaymentPackage(ctx.targetPackage) || isPaymentPackage(ctx.screenPackage)) {
                return Verdict(Tier.HARD_DENY, "PAYMENT_HARD_DENIED", "payment or banking app is hard-denied")
            }
            if (ctx.toolName == "phone_tap" || ctx.toolName == "phone_type") {
                val combined = listOfNotNull(ctx.targetText, ctx.targetDescription).joinToString(" ")
                if (isPaymentText(combined) || isPaymentText(ctx.screenSensitiveReason)) {
                    return Verdict(Tier.HARD_DENY, "PAYMENT_HARD_DENIED", "payment action is hard-denied")
                }
            }
            if (ctx.toolName == "phone_open") {
                val argPkg = ctx.arguments["package"] as? String
                if (isPaymentPackage(argPkg)) {
                    return Verdict(Tier.HARD_DENY, "PAYMENT_HARD_DENIED", "payment or banking app cannot be opened")
                }
            }
        }

        // Tier 2 / 3: conservative autonomous whitelist vs fail-closed user approval.
        if (ctx.risk == ToolRisk.READ) {
            return Verdict(Tier.AUTONOMOUS, "READ_AUTONOMOUS", "read-only tool")
        }

        return when (ctx.toolName) {
            "phone_scroll" -> Verdict(Tier.AUTONOMOUS, "BROWSE_AUTONOMOUS", "browsing scroll is autonomous")
            "phone_key" -> {
                val key = (ctx.arguments["key"] as? String)?.trim()?.lowercase()
                if (key in NAV_KEYS) {
                    Verdict(Tier.AUTONOMOUS, "NAV_KEY_AUTONOMOUS", "navigation key is autonomous")
                } else {
                    Verdict(Tier.REQUIRE_APPROVAL, "UNKNOWN_KEY", "unknown key requires approval")
                }
            }
            "phone_open" -> {
                val pkg = (ctx.arguments["package"] as? String)?.trim()
                if (!pkg.isNullOrBlank() && !ctx.sensitivePackage) {
                    Verdict(Tier.AUTONOMOUS, "OPEN_APP_AUTONOMOUS", "opening non-sensitive app is autonomous")
                } else {
                    Verdict(Tier.REQUIRE_APPROVAL, "SENSITIVE_OR_INVALID_OPEN", "sensitive or invalid package requires approval")
                }
            }
            "phone_tap" -> {
                val combined = listOfNotNull(ctx.targetText, ctx.targetDescription).joinToString(" ").trim()
                if (isOutwardText(combined)) {
                    Verdict(
                        Tier.REQUIRE_APPROVAL,
                        "OUTWARD_ACTION_APPROVAL",
                        "outward-sending or destructive action requires user approval",
                    )
                } else {
                    Verdict(Tier.REQUIRE_APPROVAL, "TAP_APPROVAL", "tap action requires user approval")
                }
            }
            "phone_type" -> Verdict(Tier.REQUIRE_APPROVAL, "TYPE_APPROVAL", "text input requires user approval")
            "workspace_write" -> Verdict(Tier.REQUIRE_APPROVAL, "WRITE_APPROVAL", "workspace write requires user approval")
            else -> Verdict(Tier.REQUIRE_APPROVAL, "DEFAULT_APPROVAL", "tool ${ctx.toolName} requires approval")
        }
    }
}
