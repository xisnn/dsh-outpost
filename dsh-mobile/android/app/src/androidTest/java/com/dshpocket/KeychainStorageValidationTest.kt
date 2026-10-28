package com.dshpocket

import android.content.Context
import android.content.pm.ApplicationInfo
import android.security.keystore.KeyInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import com.oblador.keychain.DataStorePrefsStorage
import com.oblador.keychain.SecurityLevel
import com.oblador.keychain.cipherStorage.CipherStorageKeystoreAesGcm
import com.oblador.keychain.resultHandler.ResultHandlerNonInteractive
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

/**
 * 只实现测试需要的 Context 能力；Keychain 的 cipher/storage 不依赖 React 实例。
 */
private class TestReactApplicationContext(context: Context) : ReactApplicationContext(context) {
    override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T =
        throw UnsupportedOperationException("not used in storage test")

    override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean = false

    override fun getNativeModules(): Collection<NativeModule> = emptyList()

    override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? = null

    override fun getNativeModule(moduleName: String): NativeModule? = null

    override fun getCatalystInstance(): CatalystInstance =
        throw UnsupportedOperationException("not used in storage test")

    override fun hasActiveCatalystInstance(): Boolean = false

    override fun hasActiveReactInstance(): Boolean = false

    override fun hasCatalystInstance(): Boolean = false

    override fun hasReactInstance(): Boolean = false

    override fun destroy() = Unit

    override fun handleException(e: Exception) {
        throw RuntimeException(e)
    }

    override fun isBridgeless(): Boolean = true

    override fun getJavaScriptContextHolder(): JavaScriptContextHolder? = null

    override fun getJSCallInvokerHolder(): CallInvokerHolder? = null

    override fun getFabricUIManager(): UIManager? = null

    override fun getSourceURL(): String? = null

    override fun registerSegment(segmentId: Int, path: String, callback: Callback) = Unit
}

/**
 * 真机/模拟器上的 Android 安全存储验证。
 *
 * 直接驱动 react-native-keychain 10.0.0 的 Android 实现：
 *   · CipherStorageKeystoreAesGcm：Android Keystore AES-256/GCM
 *   · DataStorePrefsStorage：密文落盘位置
 *
 * 并通过 AndroidKeyStore 的 KeyInfo 核实：
 *   · 没有 setUserAuthenticationRequired(true)，即并不存在“锁屏后必须认证”
 *     的 Keychain 级保证；
 *   · 应用 allowBackup=false。
 */
@RunWith(AndroidJUnit4::class)
class KeychainStorageValidationTest {

    companion object {
        private const val SERVICE = "dsh.pendingSends.validation"
        private const val ALIAS = "dsh.pendingSends.validation.key"

        private lateinit var context: Context
        private lateinit var reactContext: ReactApplicationContext
        private lateinit var scope: CoroutineScope
        private lateinit var prefs: DataStorePrefsStorage

        @JvmStatic
        @BeforeClass
        fun setUpClass() {
            context = InstrumentationRegistry.getInstrumentation().targetContext
            reactContext = TestReactApplicationContext(context)
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            prefs = DataStorePrefsStorage(reactContext, scope)
        }

        @JvmStatic
        @AfterClass
        fun tearDownClass() {
            try {
                prefs.removeEntry(SERVICE)
            } catch (_: Throwable) {
            }
            try {
                CipherStorageKeystoreAesGcm(reactContext, false).removeKey(ALIAS)
            } catch (_: Throwable) {
            }
            scope.cancel()
        }
    }

    private fun cipher(): CipherStorageKeystoreAesGcm =
        CipherStorageKeystoreAesGcm(reactContext, false)

    private fun encrypt(plaintext: String): Pair<ResultHandlerNonInteractive, ByteArray> {
        val handler = ResultHandlerNonInteractive()
        cipher().encrypt(handler, ALIAS, "pending-sends", plaintext, SecurityLevel.ANY)
        assertNotNull("encrypt 必须有结果", handler.encryptionResult)
        assertEquals("encrypt 不应有错误", null, handler.error)
        return handler to handler.encryptionResult!!.password
    }

    @Test
    fun androidKeystoreUsesAes256GcmWithoutUserAuthentication() {
        val (_, ciphertext) = encrypt("hello")
        assertFalse(
            "ciphertext 不能等于明文",
            ciphertext.contentEquals("hello".toByteArray(Charsets.UTF_8)),
        )

        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue("AndroidKeyStore 中应存在别名 $ALIAS", keyStore.containsAlias(ALIAS))
        val key = keyStore.getKey(ALIAS, null) as SecretKey
        val factory = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo

        assertEquals("AES", key.algorithm)
        assertEquals("必须是 256-bit AES", 256, info.keySize)
        assertFalse(
            "实测 KeyInfo.isUserAuthenticationRequired 为 false：没有锁屏认证门槛",
            info.isUserAuthenticationRequired,
        )
    }

    @Test
    fun ciphertextIsStoredInInternalDataStoreAndRoundTrips() {
        val plaintext = "P0-1 pending send secret 中文 😀"
        val (_, ciphertext) = encrypt(plaintext)
        val result = cipher().let {
            val handler = ResultHandlerNonInteractive()
            it.encrypt(handler, ALIAS, "pending-sends", plaintext, SecurityLevel.ANY)
            handler.encryptionResult!!
        }
        prefs.storeEncryptedEntry(SERVICE, result)

        val stored = prefs.getEncryptedEntry(SERVICE)
        assertNotNull("DataStore 中应有条目", stored)
        assertFalse(
            "DataStore 里不能出现明文",
            stored!!.password!!.contentEquals(plaintext.toByteArray(Charsets.UTF_8)),
        )

        val decryptHandler = ResultHandlerNonInteractive()
        cipher().decrypt(
            decryptHandler,
            ALIAS,
            stored.username!!,
            stored.password!!,
            SecurityLevel.ANY,
        )
        assertEquals("decrypt 不应有错误", null, decryptHandler.error)
        assertEquals(plaintext, decryptHandler.decryptionResult!!.password)

        val dataStoreFile = File(context.filesDir, "datastore/RN_KEYCHAIN.preferences_pb")
        assertTrue("DataStore 文件应位于应用内部存储", dataStoreFile.exists())
        val raw = dataStoreFile.readBytes()
        assertFalse(
            "DataStore 文件不能包含明文",
            String(raw, Charsets.ISO_8859_1).contains(plaintext),
        )
        // 密文以 Base64 形式落在 DataStore；至少确认文件非空。
        assertTrue(raw.isNotEmpty())
    }

    @Test
    fun allowBackupIsDisabled() {
        val flags = context.applicationInfo.flags
        assertEquals(
            "android:allowBackup 必须为 false",
            0,
            flags and ApplicationInfo.FLAG_ALLOW_BACKUP,
        )
    }

    @Test
    fun largePayloadAndWriteReadPerformance() {
        // 约 240 KiB 明文，覆盖 256 KiB 文档上限的绝大多数容量。
        val big = "A".repeat(240 * 1024)
        val start = System.nanoTime()
        val (_, ciphertext) = encrypt(big)
        val encryptMs = (System.nanoTime() - start) / 1_000_000.0

        val result = cipher().let {
            val handler = ResultHandlerNonInteractive()
            it.encrypt(handler, ALIAS, "pending-sends", big, SecurityLevel.ANY)
            handler.encryptionResult!!
        }
        val writeStart = System.nanoTime()
        prefs.storeEncryptedEntry(SERVICE, result)
        val writeMs = (System.nanoTime() - writeStart) / 1_000_000.0

        val readStart = System.nanoTime()
        val stored = prefs.getEncryptedEntry(SERVICE)!!
        val readMs = (System.nanoTime() - readStart) / 1_000_000.0

        val decryptStart = System.nanoTime()
        val decryptHandler = ResultHandlerNonInteractive()
        cipher().decrypt(decryptHandler, ALIAS, stored.username!!, stored.password!!, SecurityLevel.ANY)
        val decryptMs = (System.nanoTime() - decryptStart) / 1_000_000.0

        assertEquals("decrypt 不应有错误", null, decryptHandler.error)
        assertEquals(big, decryptHandler.decryptionResult!!.password)
        assertTrue("ciphertext 非空", ciphertext.isNotEmpty())
        assertTrue("240KiB 写入应能在 10s 内完成（实测 ${writeMs}ms）", writeMs < 10_000)
        assertTrue("240KiB 读取应能在 10s 内完成（实测 ${readMs}ms）", readMs < 10_000)
        assertTrue("加密应能在 10s 内完成（实测 ${encryptMs}ms）", encryptMs < 10_000)
        assertTrue("解密应能在 10s 内完成（实测 ${decryptMs}ms）", decryptMs < 10_000)
        println("KEYCHAIN_PERF bigPayload encrypt=${encryptMs}ms write=${writeMs}ms read=${readMs}ms decrypt=${decryptMs}ms")
    }

    @Test
    fun repeatedWritesAreStable() {
        val values = (0 until 20).map { "record-$it-" + "x".repeat(8 * 1024) }
        val start = System.nanoTime()
        for (value in values) {
            val handler = ResultHandlerNonInteractive()
            cipher().encrypt(handler, ALIAS, "pending-sends", value, SecurityLevel.ANY)
            prefs.storeEncryptedEntry(SERVICE, handler.encryptionResult!!)
        }
        val totalMs = (System.nanoTime() - start) / 1_000_000.0
        val stored = prefs.getEncryptedEntry(SERVICE)
        assertNotNull(stored)
        assertTrue("20 次 8KiB 重写应在 20s 内完成（实测 ${totalMs}ms）", totalMs < 20_000)
        println("KEYCHAIN_PERF repeatedWrites count=20 size=8KiB total=${totalMs}ms")
    }
}
