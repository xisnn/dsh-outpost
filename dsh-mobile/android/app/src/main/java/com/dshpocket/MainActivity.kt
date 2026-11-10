package com.dshpocket

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.dshpocket.runtime.RuntimeSupervisor

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Recreating the Activity must not enqueue the same external share a second time.
    if (savedInstanceState == null) ShareInbox.capture(this, intent)
  }

  override fun onResume() {
    super.onResume()
    // A visible app is an explicit user session: keep an idle local runtime
    // (e.g. while managing memory) until the 15-minute service cap or a stop.
    RuntimeSupervisor.setAppForeground(true)
  }

  override fun onPause() {
    RuntimeSupervisor.setAppForeground(false)
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // A warm singleTask delivery brings its own URI grants. Always capture this intent,
    // even when MainActivity's original launch intent was an ordinary launcher intent.
    ShareInbox.capture(this, intent)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "DshPocket"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
