package com.dshpocket.agent.background

import android.content.Context

/** Persisted "auto-start background display" preference; local-only. */
class BackgroundModeStore(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("agent-background-mode", Context.MODE_PRIVATE)

    fun enabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(value: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, value).apply()
    }

    /**
     * Whether this install has ever created a background display. After a
     * revocation the process is force-stopped by Shizuku, so the controller
     * has no in-memory history; this flag lets the UI say "permission was
     * revoked" instead of "permission was never granted".
     */
    fun everAuthorized(): Boolean = prefs.getBoolean(KEY_EVER_AUTHORIZED, false)

    fun markAuthorized() {
        if (!everAuthorized()) prefs.edit().putBoolean(KEY_EVER_AUTHORIZED, true).apply()
    }

    private companion object {
        const val KEY_ENABLED = "enabled"
        const val KEY_EVER_AUTHORIZED = "ever_authorized"
    }
}
