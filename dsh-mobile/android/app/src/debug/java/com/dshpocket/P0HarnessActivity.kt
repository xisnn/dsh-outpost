package com.dshpocket

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/** Debug-only harness activity for P0-1 Android wiring tests. */
class P0HarnessActivity : ReactActivity() {
  override fun getMainComponentName(): String = "P0Harness"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
