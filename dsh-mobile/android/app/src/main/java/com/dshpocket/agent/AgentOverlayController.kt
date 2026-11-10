package com.dshpocket.agent

import android.content.Context
import android.content.Intent
import com.dshpocket.MainActivity
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.dshpocket.agent.background.BackgroundDisplayController
import org.json.JSONObject

/**
 * Native status capsule and bottom confirmation card. It is intentionally
 * independent of RN so the stop/handoff controls remain reachable while
 * another app is in front. It only works when the user granted overlay access.
 */
class AgentOverlayController(
    context: Context,
    private val runtime: AgentRuntime,
) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val windowManager = app.getSystemService(WindowManager::class.java)
    private var statusView: View? = null
    private var cardView: View? = null
    private var statusText: TextView? = null
    private var pauseButton: Button? = null
    private var cardTitle: TextView? = null
    private var cardBody: TextView? = null
    private var allowButton: Button? = null
    private var rejectButton: Button? = null
    private var retryApprovalButton: Button? = null
    private var resumeHandoffButton: Button? = null
    private var started = false
    private var destroyed = false
    private var lastSignature = ""
    private var renderedApprovalCallId: String? = null

    private val tick = object : Runnable {
        override fun run() {
            if (destroyed) return
            update()
            main.postDelayed(this, 500)
        }
    }

    fun start() {
        if (started || destroyed) return
        if (!PhoneBridge.canDrawOverlays(app)) return
        started = true
        try {
            addStatus()
        } catch (_: Exception) {
            started = false
            return
        }
        main.post(tick)
    }

    fun destroy() {
        destroyed = true
        started = false
        main.removeCallbacks(tick)
        removeCard()
        removeStatus()
    }

    private fun update() {
        val snapshot = try {
            runtime.snapshot()
        } catch (_: Exception) {
            return
        }
        val phase = snapshot.optString("phase", "idle")
        val paused = snapshot.optBoolean("paused", false)
        val handoff = snapshot.optJSONObject("pendingHandoff")
        val approval = snapshot.optJSONObject("pendingApproval")
        val active = phase in setOf("queued", "preparing", "running", "waiting_user", "stopping")
        if (!active) {
            removeCard()
            removeStatus()
            return
        }
        if (statusView == null) {
            try {
                addStatus()
            } catch (_: Exception) {
                return
            }
        }
        statusText?.text = when {
            handoff != null -> "Agent · 请接管手机"
            approval != null -> "Agent · 等待确认"
            paused -> "Agent · 已暂停"
            phase == "stopping" -> "Agent · 停止中"
            else -> "Agent · 运行中"
        }
        pauseButton?.text = if (paused) "继续" else "暂停"
        pauseButton?.isEnabled = handoff == null && approval == null
        if (approval != null) {
            showApprovalCard(approval)
        } else if (handoff != null) {
            showHandoffCard(handoff)
        } else {
            removeCard()
        }
    }

    private fun showApprovalCard(approval: JSONObject) {
        ensureCard()
        val backgroundLost = approval.optBoolean("backgroundLost", false)
        val callId = approval.optString("callId")
        renderedApprovalCallId = callId.takeIf { it.isNotBlank() }
        val signature = "approval:$callId:$backgroundLost"
        if (signature != lastSignature) {
            cardTitle?.text = "确认手机操作 · ${approval.optString("toolName")}"
            val args = approval.optJSONObject("arguments")?.toString().orEmpty()
            cardBody?.text = buildString {
                append(args.take(240))
                if (args.length > 240) append("…")
                val digest = approval.optString("digest")
                if (digest.isNotBlank()) append("\n摘要 ").append(digest.take(12)).append("…")
                if (backgroundLost) append("\n后台屏已断开，允许后不会执行工具。")
            }
            allowButton?.visibility = View.VISIBLE
            rejectButton?.visibility = View.VISIBLE
            retryApprovalButton?.visibility = if (backgroundLost) View.VISIBLE else View.GONE
            resumeHandoffButton?.visibility = View.GONE
            lastSignature = signature
        }
        // Also update on every poll in case the display state changed without
        // changing the approval call id.
        allowButton?.isEnabled = !backgroundLost
        allowButton?.alpha = if (backgroundLost) 0.5f else 1f
        allowButton?.contentDescription =
            if (backgroundLost) "允许一次，后台屏已断开，已禁用" else null
        retryApprovalButton?.visibility = if (backgroundLost) View.VISIBLE else View.GONE
    }

    private fun showHandoffCard(handoff: JSONObject) {
        ensureCard()
        val signature = "handoff:${handoff.optString("reason")}"
        if (signature != lastSignature) {
            cardTitle?.text = "需要你接管手机"
            renderedApprovalCallId = null
            cardBody?.text = handoff.optString("reason").take(260)
            allowButton?.visibility = View.GONE
            rejectButton?.visibility = View.GONE
            retryApprovalButton?.visibility = View.GONE
            resumeHandoffButton?.visibility = View.VISIBLE
            lastSignature = signature
        }
    }

    private fun ensureCard() {
        if (cardView == null) {
            try {
                addCard()
            } catch (_: Exception) {
                // Overlay access can be revoked while a run is active.
            }
        }
    }

    private fun addStatus() {
        val root = LinearLayout(app).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(7), dp(8), dp(7))
            background = rounded(0xEE111827.toInt(), 24)
            elevation = dp(6).toFloat()
        }
        statusText = TextView(app).apply {
            text = "Agent · 运行中"
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
        }
        root.addView(statusText, LinearLayout.LayoutParams(0, WRAP, 1f))
        pauseButton = smallButton("暂停", 0xFF2F6BB0.toInt()) {
            val paused = runtime.snapshot().optBoolean("paused", false)
            if (paused) runtime.resume() else runtime.pause()
        }
        root.addView(pauseButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(8) })
        root.addView(smallButton("停止", 0xFFB23A2E.toInt()) { runtime.stop() }, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(6) })
        root.addView(smallButton("打开", 0xFF374151.toInt()) { openApp() }, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(6) })
        val params = overlayParams(Gravity.TOP or Gravity.CENTER_HORIZONTAL, dp(58))
        windowManager.addView(root, params)
        statusView = root
    }

    private fun addCard() {
        val root = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(14))
            background = rounded(0xFF111827.toInt(), 18)
            elevation = dp(8).toFloat()
        }
        cardTitle = TextView(app).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
        }
        cardBody = TextView(app).apply {
            setTextColor(0xFFD1D5DB.toInt())
            textSize = 12f
            setPadding(0, dp(6), 0, dp(10))
        }
        root.addView(cardTitle)
        root.addView(cardBody)
        val actions = LinearLayout(app).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        allowButton = smallButton("允许一次", 0xFF2F6BB0.toInt()) {
            // Only answer the approval that was actually rendered on this
            // card; a new approval may have arrived since the tap.
            val expected = renderedApprovalCallId
            val pending = runtime.snapshot().optJSONObject("pendingApproval")
            val callId = pending?.optString("callId").orEmpty()
            if (expected != null && callId == expected) runtime.decide(callId, true)
        }
        rejectButton = smallButton("拒绝", 0xFFB23A2E.toInt()) {
            val expected = renderedApprovalCallId
            val pending = runtime.snapshot().optJSONObject("pendingApproval")
            val callId = pending?.optString("callId").orEmpty()
            if (expected != null && callId == expected) runtime.decide(callId, false)
        }
        retryApprovalButton = smallButton("重试后台屏", 0xFF374151.toInt()) {
            BackgroundDisplayController.retryIfExists()
        }.apply { visibility = View.GONE }
        resumeHandoffButton = smallButton("已接管，继续", 0xFF2F6BB0.toInt()) {
            runtime.resumeHandoff()
        }
        actions.addView(retryApprovalButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(8) })
        actions.addView(allowButton)
        actions.addView(rejectButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(8) })
        actions.addView(resumeHandoffButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(8) })
        root.addView(actions)
        val params = overlayParams(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL, dp(24)).apply {
            width = WindowManager.LayoutParams.MATCH_PARENT
        }
        windowManager.addView(root, params)
        cardView = root
    }

    private fun removeStatus() {
        statusView?.let {
            try { windowManager.removeView(it) } catch (_: Exception) { }
        }
        statusView = null
        statusText = null
        pauseButton = null
    }

    private fun removeCard() {
        cardView?.let {
            try { windowManager.removeView(it) } catch (_: Exception) { }
        }
        cardView = null
        cardTitle = null
        cardBody = null
        allowButton = null
        rejectButton = null
        retryApprovalButton = null
        resumeHandoffButton = null
        renderedApprovalCallId = null
        lastSignature = ""
    }

    private fun overlayParams(gravity: Int, y: Int, focusable: Boolean = false) = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply {
        this.gravity = gravity
        this.y = y
    }

    private fun smallButton(label: String, color: Int, action: () -> Unit): Button =
        Button(app).apply {
            text = label
            textSize = 11f
            setTextColor(Color.WHITE)
            isAllCaps = false
            minWidth = 0
            minimumWidth = 0
            minHeight = 0
            minimumHeight = 0
            setPadding(dp(10), dp(6), dp(10), dp(6))
            background = rounded(color, 14)
            setOnClickListener { action() }
        }

    private fun rounded(color: Int, radiusDp: Int): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radiusDp).toFloat()
        }

    private fun openApp() {
        val intent = Intent(app, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        try {
            app.startActivity(intent)
        } catch (_: Exception) {
        }
    }

    private fun dp(value: Int): Int =
        (value * app.resources.displayMetrics.density).toInt()

    private companion object {
        const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
