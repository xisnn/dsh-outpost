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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val image = ImageView(this).apply {
            setImageResource(R.drawable.splash)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(
                ContextCompat.getColor(this@SplashActivity, R.color.splash_background)
            )
        }
        setContentView(image)

        Handler(Looper.getMainLooper()).postDelayed({
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }, 650)
    }
}
