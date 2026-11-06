package com.dshpocket

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.widget.Toast
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Own private copies before exposing an external provider's data to the composer. */
internal object ShareInbox {
  private const val MAX_FILE = 50L * 1024 * 1024
  private const val MAX_TOTAL = 256L * 1024 * 1024
  private const val MAX_TEXT = 2 * 1024 * 1024
  private const val MAX_RECORD = 16L * 1024 * 1024 // JSON escaping can expand the 2 MiB text.
  private const val MAX_FILES = 16
  private const val TTL = 30L * 24 * 60 * 60 * 1000
  // One running job and at most eight waiting jobs, including bridge requests.
  private val worker = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
    ArrayBlockingQueue<Runnable>(8), ThreadPoolExecutor.AbortPolicy())
  @Volatile private var react = WeakReference<ReactApplicationContext>(null)
  private fun root(context: Context) = File(context.filesDir, "outpost-share-inbox-v1").apply {
    check(isDirectory || mkdirs()) { "Cannot create inbox" }
  }
  private fun changed() {
    val context = react.get() ?: return
    try {
      if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("OutpostShareInboxChanged", null)
    } catch (_: Exception) { /* The persisted inbox is read after the next native/JS handshake. */ }
  }
  fun attach(context: ReactApplicationContext) { react = WeakReference(context) }
  private fun notify(context: Context, text: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_LONG).show() }
  }
  private fun enqueue(onBusy: () -> Unit, task: () -> Unit) {
    try { worker.execute { task() } } catch (_: RejectedExecutionException) { onBusy() }
  }
  private fun streams(intent: Intent): List<Uri> {
    val values = mutableListOf<Uri>()
    try {
      @Suppress("DEPRECATION")
      val extra = intent.extras?.get(Intent.EXTRA_STREAM)
      when (extra) {
        is Uri -> values.add(extra)
        is ArrayList<*> -> extra.take(MAX_FILES + 1).filterIsInstance<Uri>().forEach { values.add(it) }
        is Array<*> -> extra.take(MAX_FILES + 1).filterIsInstance<Uri>().forEach { values.add(it) }
      }
    } catch (_: Exception) { /* Invalid extras must not hide otherwise usable ClipData. */ }
    try {
      intent.clipData?.let { clip ->
        for (i in 0 until minOf(clip.itemCount, MAX_FILES + 1)) clip.getItemAt(i).uri?.let { values.add(it) }
      }
    } catch (_: Exception) { /* Invalid external parcel data does not crash the Activity. */ }
    return values.distinctBy { it.toString() }.take(MAX_FILES + 1)
  }
  fun isShare(intent: Intent) = intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

  /** MainActivity owns the forwarded grants, including each singleTask onNewIntent delivery. */
  fun forwardGrants(source: Intent, target: Intent) {
    if (!isShare(source)) return
    target.action = source.action
    target.type = source.type
    try {
      target.putExtra(Intent.EXTRA_SUBJECT, source.getStringExtra(Intent.EXTRA_SUBJECT))
      // Flatten styled text rather than forwarding arbitrary external parcelables to MainActivity.
      target.putExtra(Intent.EXTRA_TEXT, source.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
    } catch (_: Exception) { /* Malformed extras may still have usable ClipData. */ }
    val uris = streams(source)
    target.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
    val content = uris.filter { it.scheme == "content" }
    if (content.isEmpty() || source.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) return
    target.clipData = ClipData.newRawUri("Shared files", content.first()).apply {
      content.drop(1).forEach { addItem(ClipData.Item(it)) }
    }
    target.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }
  private fun diskBytes(base: File): Long = base.walkTopDown().filter { it.isFile }.sumOf { it.length() }
  private fun writeRecord(dir: File, record: JSONObject) {
    val bytes = record.toString().toByteArray(Charsets.UTF_8)
    check(bytes.size.toLong() <= MAX_RECORD) { "Inbox record too large" }
    // Count metadata, the text fallback, and the old record while the replacement is written.
    check(diskBytes(checkNotNull(dir.parentFile)) + bytes.size <= MAX_TOTAL) { "Inbox full" }
    val temp = File(dir, "record.tmp")
    try {
      temp.writeBytes(bytes)
      check(temp.renameTo(File(dir, "record.json"))) { "Inbox commit failed" }
    } finally { temp.delete() }
  }
  private fun record(dir: File): JSONObject? = try {
    val file = File(dir, "record.json")
    if (file.isFile && file.length() <= MAX_RECORD) JSONObject(file.readText(Charsets.UTF_8)) else null
  } catch (_: Exception) { null }
  private fun item(context: Context, id: String): File {
    require(Regex("^[0-9a-fA-F-]{36}$").matches(id))
    val base = root(context).canonicalFile
    return File(base, id).canonicalFile.also { require(it.parentFile == base) }
  }
  // Only runs on the same worker as copying/acknowledgement, never against an active copy.
  private fun cleanup(base: File) {
    val now = System.currentTimeMillis()
    base.listFiles()?.filter { it.isDirectory && Regex("^[0-9a-fA-F-]{36}$").matches(it.name) }?.forEach { dir ->
      if (record(dir) == null || now - dir.lastModified() > TTL) dir.deleteRecursively()
      else File(dir, "record.tmp").delete()
    }
  }
  fun initialize(context: Context) {
    val app = context.applicationContext
    enqueue({ /* The next inbox operation also performs cleanup. */ }) {
      try { cleanup(root(app)) } catch (_: Exception) { /* Retry on the next inbox operation. */ }
    }
  }
  fun capture(context: Context, intent: Intent) {
    if (!isShare(intent)) return
    val app = context.applicationContext
    val uris = streams(intent)
    val text = try {
      listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        .filter { it.isNotBlank() }.distinct().joinToString("\n\n")
    } catch (_: Exception) { "" }
    enqueue({ notify(app, "分享收件箱正忙，请稍后重新分享") }) {
      var dir: File? = null
      try {
        val base = root(app)
        cleanup(base)
        if ((base.listFiles()?.count { record(it)?.optBoolean("imported") == false } ?: 0) >= 8) {
          notify(app, "分享收件箱已满，请先处理之前的内容")
          return@enqueue
        }
        val id = UUID.randomUUID().toString()
        val destination = item(app, id)
        dir = destination
        check(destination.mkdir()) { "Cannot create share" }
        val skipped = JSONArray()
        val files = JSONArray()
        var total = diskBytes(base)
        var incoming = text
        if (incoming.length > MAX_TEXT || incoming.toByteArray(Charsets.UTF_8).size > MAX_TEXT) {
          incoming = ""
          skipped.put("分享文字超过 2 MB，请改为文件分享")
        }
        val data = JSONObject().put("id", id).put("receivedAt", System.currentTimeMillis())
          .put("text", incoming).put("files", files).put("skipped", skipped).put("imported", false)
        // Keep a TXT fallback so adding text never truncates an existing full draft.
        if (incoming.isNotEmpty()) {
          val bytes = incoming.toByteArray(Charsets.UTF_8)
          if (total + bytes.size > MAX_TOTAL) {
            data.put("text", "")
            skipped.put("分享暂存空间已满，文字未导入")
          } else {
            val copy = File(destination, "shared-text.txt")
            copy.writeBytes(bytes)
            total += bytes.size
            data.put("textFile", JSONObject().put("uri", Uri.fromFile(copy).toString()).put("name", "分享文字.txt")
              .put("mime", "text/plain").put("kind", "file").put("size", bytes.size))
          }
        }
        if (uris.size > MAX_FILES) skipped.put("一次最多导入 16 个文件，多出的文件未导入")
        uris.take(MAX_FILES).forEachIndexed { index, uri ->
          val authority = uri.authority?.substringAfterLast('@') ?: ""
          if (uri.scheme != "content" || authority == app.packageName || authority.startsWith(app.packageName + ".")) {
            skipped.put("已跳过不支持的文件来源")
            return@forEachIndexed
          }
          val copy = File(destination, "file-$index-${UUID.randomUUID()}")
          try {
            var name = "分享文件-${index + 1}"
            app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
              if (cursor.moveToFirst()) cursor.getString(0)?.let { name = it }
            }
            name = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(256).ifBlank { "分享文件" }
            val rawMime = app.contentResolver.getType(uri)?.take(128) ?: "application/octet-stream"
            val mime = if (Regex("^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$").matches(rawMime)) rawMime else "application/octet-stream"
            var size = 0L
            val deadline = SystemClock.elapsedRealtime() + 30_000
            app.contentResolver.openInputStream(uri)?.use { input ->
              copy.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                  // Read at most one byte past either remaining budget; never trust provider SIZE.
                  val remaining = minOf(MAX_FILE - size, MAX_TOTAL - total - size)
                  check(remaining >= 0) { "Limit exceeded" }
                  check(SystemClock.elapsedRealtime() <= deadline) { "Copy timed out" }
                  val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining + 1).toInt())
                  check(SystemClock.elapsedRealtime() <= deadline) { "Copy timed out" }
                  if (count < 0) break
                  if (count == 0) error("Source made no progress")
                  check(count.toLong() <= remaining) { "Limit exceeded" }
                  output.write(buffer, 0, count)
                  size += count
                }
              }
            } ?: error("Unreadable source")
            total += size
            val image = mime.lowercase() in setOf("image/png", "image/jpeg", "image/webp", "image/gif")
            files.put(JSONObject().put("uri", Uri.fromFile(copy).toString()).put("name", name)
              .put("size", size).put("mime", mime).put("kind", if (image) "image" else "file"))
          } catch (_: Exception) {
            copy.delete()
            // Failed deletions still consume the private storage budget.
            total = diskBytes(base)
            skipped.put("有文件无法读取、超过 50 MB 或暂存空间不足，未导入该文件")
          }
        }
        if (data.optString("text").isBlank() && files.length() == 0 && skipped.length() == 0) skipped.put("未收到可导入的文字或文件")
        writeRecord(destination, data)
        changed()
      } catch (_: Exception) {
        dir?.deleteRecursively()
        notify(app, "分享内容暂存失败，请重新分享")
      }
    }
  }
  fun pending(context: Context, promise: Promise) = enqueue({
    promise.reject("share-busy", "分享收件箱正忙，请稍后重试")
  }) {
    try {
      val base = root(context)
      cleanup(base)
      val values = base.listFiles()?.mapNotNull { record(it) }?.filter { !it.optBoolean("imported") }
        ?.sortedBy { it.optLong("receivedAt") } ?: emptyList()
      promise.resolve(JSONArray(values).toString())
    } catch (_: Exception) { promise.reject("share-read-failed", "暂时无法读取分享内容") }
  }
  fun finish(context: Context, id: String, discard: Boolean, promise: Promise) = enqueue({
    promise.reject("share-busy", "分享收件箱正忙，请稍后重试")
  }) {
    try {
      val dir = item(context, id)
      if (discard) {
        check(!dir.exists() || dir.deleteRecursively())
      } else {
        val value = record(dir) ?: error("Missing share")
        writeRecord(dir, value.put("imported", true))
      }
      promise.resolve(null)
      changed()
    } catch (_: Exception) { promise.reject("share-finish-failed", "未能更新分享收件箱，请重试") }
  }
}

class ShareInboxModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  init { ShareInbox.attach(context) }
  override fun getName() = "OutpostShareInbox"
  @ReactMethod fun listPending(promise: Promise) { ShareInbox.pending(reactApplicationContext, promise) }
  @ReactMethod fun acknowledge(id: String, promise: Promise) { ShareInbox.finish(reactApplicationContext, id, false, promise) }
  @ReactMethod fun discard(id: String, promise: Promise) { ShareInbox.finish(reactApplicationContext, id, true, promise) }
  @ReactMethod fun addListener(name: String) { }
  @ReactMethod fun removeListeners(count: Double) { }
}

class ShareInboxPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(ShareInboxModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
