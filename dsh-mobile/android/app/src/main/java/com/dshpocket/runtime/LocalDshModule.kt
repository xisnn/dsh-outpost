package com.dshpocket.runtime

import android.net.Uri
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.dshpocket.runtime.install.RuntimeManifest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

class LocalDshModule(private val react: ReactApplicationContext) : ReactContextBaseJavaModule(react), RuntimeSupervisor.Observer {
  private val worker = Executors.newSingleThreadExecutor()
  private val supervisor by lazy { RuntimeSupervisor.get(react) }
  override fun getName() = "OutpostLocalDsh"

  /**
   * The P6 packages intentionally do not contain the legacy DSH runtime. Hide
   * the legacy local entry in that case instead of offering an import screen
   * that can never succeed. Older packages without this constant keep their
   * previous behavior.
   */
  override fun getConstants(): Map<String, Any> {
    val hasManifest = try {
      react.assets.list("dsh-runtime")?.any { it.endsWith(".json") } == true
    } catch (_: Exception) {
      false
    }
    val libDir = react.applicationInfo.nativeLibraryDir
    val hasProot = File(libDir, "libproot.so").isFile && File(libDir, "libproot-loader.so").isFile
    return mapOf("hasBundledRuntime" to (hasManifest && hasProot))
  }
  private var attached: RuntimeSupervisor? = null
  override fun initialize() {
    super.initialize()
    try { attached=supervisor; attached?.attach(this) } catch (_: Exception) { /* Local state corruption must not prevent remote-host use. Calls fail closed. */ }
  }
  // A React reload detaches this observer only. Native services, installation and DSH survive.
  override fun invalidate() { attached?.detach(this); attached=null; worker.shutdown(); super.invalidate() }
  override fun changed() {
    if (react.hasActiveReactInstance()) try {
      react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("OutpostLocalDshChanged", null)
    } catch (_: Exception) { /* Persisted cursors and snapshot close any notification gap. */ }
  }
  private fun fail(promise: Promise, error: Throwable) {
    val cause = error.cause ?: error
    val code = cause.message?.takeIf { it.matches(Regex("[A-Z_]{1,80}")) } ?: "LOCAL_RUNTIME_ERROR"
    promise.reject(code, code)
  }
  private fun complete(promise: Promise, future: CompletableFuture<JSONObject>) {
    future.whenComplete { value, error -> if (error != null) fail(promise, error) else promise.resolve(value.toString()) }
  }
  @ReactMethod fun addListener(name: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
  @ReactMethod fun snapshot(promise: Promise) { worker.execute { try { promise.resolve(supervisor.snapshot().toString()) } catch (error: Exception) { fail(promise,error) } } }
  @ReactMethod fun events(after: Double, promise: Promise) {
    worker.execute { try { require(after.isFinite() && after >= 0 && after <= 9007199254740990.0 && after % 1.0 == 0.0);promise.resolve(supervisor.events(after.toLong()).toString()) } catch (error: Exception) { fail(promise,error) } }
  }
  @ReactMethod fun start(acknowledgedGeneration: String?, promise: Promise) {
    val activity = react.currentActivity
    if (activity == null || !activity.hasWindowFocus()) { promise.reject("VISIBLE_ACTIVITY_REQUIRED","VISIBLE_ACTIVITY_REQUIRED");return }
    try { complete(promise,DshRuntimeService.launch(react,acknowledgedGeneration)) } catch (error: Exception) { fail(promise,error) }
  }
  @ReactMethod fun stop(promise: Promise) {
    try {
      supervisor.stop("user-stop",false)
      // Resolve only after cleanup reaches a terminal phase (or the bounded
      // timeout). Resolving immediately let RN overwrite the newer stop state
      // with a stale "running" snapshot and allowed Start during stopping.
      worker.execute {
        try {
          val deadline=android.os.SystemClock.elapsedRealtime()+15000
          var current=supervisor.snapshot()
          while(android.os.SystemClock.elapsedRealtime()<deadline){
            val phase=current.optString("phase")
            if(phase!="starting" && phase!="running" && phase!="stopping") break
            Thread.sleep(150)
            current=supervisor.snapshot()
          }
          promise.resolve(current.toString())
        } catch(error: Exception) { fail(promise,error) }
      }
    } catch(error: Exception) { fail(promise,error) }
  }
  @ReactMethod fun query(generation: String, operation: String, argsText: String, promise: Promise) {
    try {
      require(argsText.length <= 65536) { "QUERY_ARGUMENTS" }
      complete(promise,supervisor.request(generation,operation,JSONObject(argsText)))
    } catch(error: Exception) { fail(promise,error) }
  }
  @ReactMethod fun rollback(promise: Promise) { try { complete(promise,supervisor.rollback()) } catch(error: Exception) { fail(promise,error) } }
  /**
   * Runtime manifests bundled in the signed APK. The UI uses these ids to
   * import the matching artifact; trust still comes from the APK asset, never
   * from the picked file.
   */
  @ReactMethod fun bundledDistributions(promise: Promise) {
    worker.execute {
      try {
        val names=react.assets.list("dsh-runtime")?.filter { it.endsWith(".json") }?.sorted()?.take(8) ?: emptyList()
        val rows=JSONArray()
        for (name in names) {
          try {
            val manifest=react.assets.open("dsh-runtime/$name").bufferedReader().use { JSONObject(it.readText()) }
            val id=manifest.optString("id")
            if (!id.matches(Regex("[a-zA-Z0-9._-]{1,100}")) || "$id.json" != name) continue
            // A dual-ABI APK may carry more than one runtime manifest. Only the
            // artifact matching this device's primary ABI is installable.
            if (manifest.optString("abi") != android.os.Build.SUPPORTED_ABIS[0]) continue
            rows.put(JSONObject().put("id",id).put("version",manifest.optString("version")).put("abi",manifest.optString("abi")))
          } catch (_: Exception) { /* A malformed bundled manifest is ignored, never guessed. */ }
        }
        promise.resolve(rows.toString())
      } catch (error: Exception) { fail(promise,error) }
    }
  }
  @ReactMethod fun install(distributionId: String, contentUri: String, promise: Promise) {
    worker.execute {
      var temporary: File? = null
      try {
        require(distributionId.matches(Regex("[a-zA-Z0-9._-]{1,100}")))
        val uri=Uri.parse(contentUri)
        require(uri.scheme == "content")
        // Trust comes from the signed APK, never a sidecar supplied with a download.
        val manifest=react.assets.open("dsh-runtime/$distributionId.json").bufferedReader().use { RuntimeManifest.fromTrustedAppJson(JSONObject(it.readText())) }
        val staged=File.createTempFile("outpost-runtime-", ".tar", react.cacheDir)
        temporary=staged
        react.contentResolver.openInputStream(uri).use { input ->
          requireNotNull(input)
          FileOutputStream(staged).use { output ->
            val buffer=ByteArray(65536);var total=0L
            while(true) { val n=input.read(buffer);if(n<0)break;total+=n;if(total>1024L*1024*1024)error("ARCHIVE_SIZE");output.write(buffer,0,n) }
            output.fd.sync()
          }
        }
        // Installation executes on the supervisor queue, serialized against start and rollback.
        supervisor.install(staged,manifest).whenComplete { value,error -> staged.delete();if(error!=null)fail(promise,error)else promise.resolve(value.toString()) }
        temporary=null
      } catch(error: Exception) { temporary?.delete();fail(promise,error) }
    }
  }
}

class LocalDshPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(LocalDshModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
