package com.dshpocket.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.dshpocket.MainActivity

/**
 * P6-0 foreground owner for the self-hosted agent. START_NOT_STICKY: the task
 * is not silently restarted after a process death; the run store remains the
 * place to inspect the interruption.
 */
class AgentService : Service() {
    companion object {
        const val ACTION_RUN = "com.dshpocket.agent.RUN"
        const val ACTION_STOP = "com.dshpocket.agent.STOP"
        private const val CHANNEL = "outpost-agent"
        private const val NOTIFICATION_ID = 4201
    }

    private var overlay: AgentOverlayController? = null
    private val handler = Handler(Looper.getMainLooper())
    private var lastNotificationText = "Agent 运行中"
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_OFF) {
                AgentRuntime.get(this@AgentService).stop()
                updateNotification("屏幕已锁定，手机任务停止")
            }
        }
    }
    private val notificationTick = object : Runnable {
        override fun run() {
            val snapshot = try {
                AgentRuntime.get(this@AgentService).snapshot()
            } catch (_: Exception) {
                null
            }
            if (snapshot != null) {
                val handoff = snapshot.optJSONObject("pendingHandoff")
                val approval = snapshot.optJSONObject("pendingApproval")
                val phase = snapshot.optString("phase", "idle")
                val text = when {
                    handoff != null -> "需要你接管手机"
                    approval != null -> "等待确认 · ${approval.optString("toolName")}"
                    snapshot.optBoolean("paused", false) -> "Agent 已暂停"
                    phase == "stopping" -> "Agent 停止中"
                    phase in setOf("queued", "preparing", "running", "waiting_user") -> "Agent 运行中"
                    else -> null
                }
                if (text != null) updateNotification(text)
            }
            handler.postDelayed(this, 700)
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "本机 Agent", NotificationManager.IMPORTANCE_LOW),
            )
        }
        startForeground(NOTIFICATION_ID, notification("Agent 运行中"))
        // Register before the bridge starts the run: a fast failure may finish
        // before onStartCommand arrives, and the service must still stop.
        val runtime = AgentRuntime.get(this)
        runtime.setOnFinished { stopSelf() }
        overlay = AgentOverlayController(this, runtime).also { it.start() }
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(screenReceiver, filter)
        }
        handler.post(notificationTick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val snapshot = AgentRuntime.get(this).snapshot()
            val phase = snapshot.optString("phase", "idle")
            if (phase in setOf("queued", "preparing", "running", "waiting_user", "stopping")) {
                AgentRuntime.get(this).stop()
            } else {
                stopSelf()
            }
            return START_NOT_STICKY
        }
        // The RN bridge starts the actual run (demo or cloud) after asking the
        // service to enter the foreground. Starting a demo here would race the
        // bridge's startCloud and could silently replace the requested run.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(notificationTick)
        try {
            unregisterReceiver(screenReceiver)
        } catch (_: Exception) {
        }
        overlay?.destroy()
        overlay = null
        AgentRuntime.get(this).setOnFinished(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateNotification(text: String) {
        if (text == lastNotificationText) return
        lastNotificationText = text
        try {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
        } catch (_: Exception) {
            // Notification permission can be denied; the foreground service and
            // in-app controls still work.
        }
    }

    private fun notification(text: String): Notification {
        val content = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("DSH 本机 Agent")
            .setContentText(text)
            .setContentIntent(content)
            .setOngoing(true)
            .build()
    }
}
