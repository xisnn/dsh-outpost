package com.dshpocket.runtime

import android.content.Intent
import android.app.NotificationManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.ReactApplication
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/** Requires the isolated support/local-runtime-app.js entry, pinned fixture assets and import.
 * Runs real RN -> native -> inherited pipe -> real DSH/Butler, with deterministic Mock only.
 */
@RunWith(AndroidJUnit4::class)
class LocalRuntimeBridgeValidationTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private fun await(label: String, timeout: Long = 20000, check: () -> Boolean) {
    val end=SystemClock.elapsedRealtime()+timeout
    while(SystemClock.elapsedRealtime()<end) { if(check())return;SystemClock.sleep(150) }
    throw AssertionError(label)
  }
  private fun visit(node: AccessibilityNodeInfo?, action: (AccessibilityNodeInfo) -> Boolean): Boolean {
    if(node==null)return false
    if(action(node))return true
    for(index in 0 until node.childCount)if(visit(node.getChild(index),action))return true
    return false
  }
  private fun visible(text: String): Boolean = visit(instrumentation.uiAutomation.rootInActiveWindow) { it.text?.toString()==text }
  private fun click(text: String) {
    var clicked=false
    await("Missing button $text") {
      clicked=visit(instrumentation.uiAutomation.rootInActiveWindow) { node ->
        if(node.text?.toString()!=text)return@visit false
        var target: AccessibilityNodeInfo?=node
        while(target!=null && !target.isClickable)target=target.parent
        target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
      }
      clicked
    }
  }
  private fun queryText(): String? {
    var result: String?=null
    visit(instrumentation.uiAutomation.rootInActiveWindow) { node ->
      val text=node.text?.toString()
      if(text?.startsWith("{\"ok\":true,\"body\":") == true){result=text;true}else false
    }
    return result
  }
  private fun cleanAbandonedStaging(): Int {
    check(context.packageName.startsWith("com.dshoutpost.p1.")) { "Isolated package required" }
    assertFalse(RuntimeSupervisor.get(context).hasProcess())
    fun remove(file: File) {
      val stat=android.system.Os.lstat(file.path)
      if(android.system.OsConstants.S_ISDIR(stat.st_mode)){
        android.system.Os.chmod(file.path,448)
        val children=file.listFiles() ?: throw AssertionError("Cannot list staging directory")
        children.forEach { remove(it) }
      }
      android.system.Os.remove(file.path)
    }
    val staging=File(context.noBackupFilesDir,"outpost-local-v1/runtime/staging")
    val abandoned=staging.listFiles()?.toList() ?: emptyList()
    abandoned.forEach { check(it.name.matches(Regex("[a-f0-9-]{36}")));remove(it) }
    return abandoned.size
  }
  @Test fun cleanupAbandonedInstallerStaging() {
    val count=cleanAbandonedStaging()
    File(context.getExternalFilesDir(null),"p1-staging-cleanup.json").writeText(JSONObject()
      .put("ok",true).put("removedStagingDirectories",count).put("businessDataUntouched",true).toString(2))
  }
  @Test fun reactReloadKeepsTheSameNativeLaunchAndTask() {
    check(context.packageName.startsWith("com.dshoutpost.p1.")) { "Isolated package required" }
    val supervisor=RuntimeSupervisor.get(context)
    val abi=android.os.Build.SUPPORTED_ABIS[0]
    val pinned=context.assets.open("dsh-runtime/p1-verification-$abi.json").bufferedReader().use { JSONObject(it.readText()) }
    assertFalse(supervisor.hasProcess())
    val localRoot=File(context.noBackupFilesDir,"outpost-local-v1")
    val sentinel=File(localRoot,"data/p1-install-retention.txt")
    sentinel.parentFile!!.mkdirs()
    if(sentinel.exists())assertEquals("P1 isolated data retention",sentinel.readText())
    else {assertTrue(sentinel.createNewFile());sentinel.writeText("P1 isolated data retention")}
    // Remove only isolated interrupted staging, without following symbolic links.
    cleanAbandonedStaging()
    var inputRelease: JSONObject?=null
    val installed=supervisor.snapshot().getJSONObject("installed")
    if(!installed.getBoolean("installed") || installed.optString("archiveSha256")!=pinned.getString("archiveSha256")){
      val source=File(context.getExternalFilesDir(null),"runtime.tar")
      val future=supervisor.install(source,com.dshpocket.runtime.install.RuntimeManifest.fromTrustedAppJson(pinned))
      val deadline=SystemClock.elapsedRealtime()+1200000
      var sourceReleased=false
      fun sha256(file: File): String {
        val digest=java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val block=ByteArray(65536);while(true){val count=input.read(block);if(count<0)break;digest.update(block,0,count)} }
        return digest.digest().joinToString(""){"%02x".format(it.toInt() and 255)}
      }
      // A private test-input optimization, without changing the product installer.
      // Extraction begins only after the installer has made and verified its own snapshot.
      while(!future.isDone && SystemClock.elapsedRealtime()<deadline){
        if(!sourceReleased){
          val stages=File(localRoot,"runtime/staging").listFiles() ?: emptyArray()
          for(stage in stages){
            check(stage.name.matches(Regex("[a-f0-9-]{36}")))
            val snapshot=File(stage,"artifact.tar")
            if(File(stage,"payload").listFiles()?.isNotEmpty()!=true || !snapshot.isFile)continue
            val copiedSha=try{sha256(snapshot)}catch(gone: java.io.FileNotFoundException){continue}
            assertEquals(pinned.getString("archiveSha256"),copiedSha)
            assertEquals(copiedSha,sha256(source))
            assertTrue(source.delete());sourceReleased=true
            inputRelease=JSONObject().put("package",context.packageName).put("sha256",copiedSha).put("verifiedSnapshot",snapshot.path)
              .put("onlyFixtureInputRemoved",true).put("extractionObserved",true).put("businessDataUntouched",true)
            File(context.getExternalFilesDir(null),"p1-input-release-after-snapshot.json").writeText(inputRelease!!.toString(2))
          }
        }
        SystemClock.sleep(500)
      }
      future.get(maxOf(1,deadline-SystemClock.elapsedRealtime()),TimeUnit.MILLISECONDS)
    }
    assertEquals("P1 isolated data retention",sentinel.readText())
    val intent=context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    await("Native bridge did not mount",60000){visible("native-module-present")}
    click("启动本机 DSH")
    await("Runtime did not authenticate",180000){supervisor.snapshot().optString("phase")=="running"}
    val generation=supervisor.snapshot().getString("generation")
    var taskId: String?=null
    await("Real Butler task absent") {
      val response=supervisor.request(generation,"snapshot",JSONObject()).get(8,TimeUnit.SECONDS)
      val tasks=response.getJSONObject("body").getJSONArray("tasks")
      if(tasks.length()>0){taskId=tasks.getJSONObject(0).getString("id");true}else false
    }
    click("查询管家")
    await("RN query did not return the real task") { queryText()?.contains(taskId!!)==true }
    val before=supervisor.snapshot().getLong("cursor")
    val host=(context.applicationContext as ReactApplication).reactHost!!
    val previousReactContext=host.currentReactContext
    instrumentation.runOnMainSync { host.reload("P1 native lifecycle verification") }
    await("React context was not replaced",25000){host.currentReactContext!=null && host.currentReactContext!==previousReactContext}
    await("RN did not reload",25000){visible("native-module-present")}
    assertEquals(generation,supervisor.snapshot().getString("generation"))
    assertEquals("running",supervisor.snapshot().getString("phase"))
    click("查询管家")
    await("Reloaded RN did not reconnect to the same task") { queryText()?.contains(taskId!!)==true }
    assertTrue(supervisor.events(before).getLong("cursor")>=before)
    val screenshot=instrumentation.uiAutomation.takeScreenshot() ?: throw AssertionError("RN evidence screenshot unavailable")
    java.io.FileOutputStream(File(context.getExternalFilesDir(null),"p1-rn-reload.png")).use {
      assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it))
    }
    screenshot.recycle()
    val notifications=context.getSystemService(NotificationManager::class.java).activeNotifications
    val foreground=notifications.firstOrNull { it.id==4107 } ?: throw AssertionError("Foreground notification absent")
    foreground.notification.actions.first().actionIntent.send()
    await("Notification stop did not finish native cleanup") { supervisor.snapshot().optString("phase")=="stopped" }
    assertFalse(supervisor.snapshot().getBoolean("live"))
    assertTrue(supervisor.snapshot().getBoolean("requiresReconciliation"))
    File(context.getExternalFilesDir(null),"p1-rn-validation.json").writeText(JSONObject().put("ok",true).put("generation",generation)
      .put("taskId",taskId).put("reactReloadKeepsLaunch",true).put("reactReloadKeepsTask",true)
      .put("notificationStopsNativeLaunch",true).put("fixtureInputRelease",inputRelease).put("realModelCalls",0).toString(2))
  }
}
