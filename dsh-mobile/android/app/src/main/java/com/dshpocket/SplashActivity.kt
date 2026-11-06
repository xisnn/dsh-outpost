package com.dshpocket

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * 启动页：满屏显示品牌图（centerCrop），短暂停留后进 MainActivity。
 *
 * 用独立 Activity 而不是 windowBackground，是因为窗口背景的 bitmap
 * 只能 center/fill，做不到等比裁剪铺满。
 *
 * 背景色取品牌图顶部天空的深藏蓝（@color/splash_background，Android 12+ 的
 * 系统闪屏也用同色），系统闪屏 → 这里不会有颜色跳变。
 */
class SplashActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val openMain = Runnable { forwardToMain(intent) }

    private fun forwardToMain(source: Intent) {
        handler.removeCallbacks(openMain)
        val next = Intent(this, MainActivity::class.java)
        ShareInbox.forwardGrants(source, next)
        startActivity(next)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Forward every delivery, not just the latest intent when a splash timer expires.
        forwardToMain(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ShareInbox.isShare(intent)) {
            // MainActivity's task owns the URI grants before this Activity finishes.
            forwardToMain(intent)
            return
        }

        val image = ImageView(this).apply {
            setImageResource(R.drawable.splash)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(
                ContextCompat.getColor(this@SplashActivity, R.color.splash_background)
            )
        }
        setContentView(image)

        handler.postDelayed(openMain, 650)
    }

    override fun onDestroy() {
        handler.removeCallbacks(openMain)
        super.onDestroy()
    }
}
