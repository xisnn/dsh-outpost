package com.dshpocket.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.dshpocket.agent.core.ModelConfig
import com.dshpocket.agent.core.ModelProtocol
import com.dshpocket.agent.core.modelBaseUrlAllowed
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores cloud-model metadata in private SharedPreferences and the API key as
 * AES/GCM ciphertext backed by Android Keystore. The key is never returned to
 * the JS layer after a save; only [hasKey] is exposed.
 */
class AgentSettingsStore(context: Context) {
    private companion object {
        const val PREFS = "outpost-agent-model"
        const val KEY_PROTOCOL = "protocol"
        const val KEY_BASE_URL = "baseUrl"
        const val KEY_MODEL = "model"
        const val KEY_CIPHER = "apiKeyCipher"
        const val KEY_ALIAS = "dsh.agent.model.key.v1"
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun read(): JSONObject {
        val protocol = ModelProtocol.fromWire(prefs.getString(KEY_PROTOCOL, null))
            ?: ModelProtocol.OPENAI_COMPAT
        val cipherText = prefs.getString(KEY_CIPHER, null)
        val readable = cipherText != null && runCatching { decrypt(cipherText) }.isSuccess
        return JSONObject()
            .put("supported", true)
            .put("protocol", protocol.name)
            .put("baseUrl", prefs.getString(KEY_BASE_URL, null) ?: ModelConfig.defaultBaseUrl(protocol))
            .put("model", prefs.getString(KEY_MODEL, null) ?: "")
            .put("hasKey", readable)
    }

    @Synchronized
    fun save(protocol: String, baseUrl: String, model: String, apiKey: String?): JSONObject {
        val parsed = ModelProtocol.fromWire(protocol) ?: ModelProtocol.OPENAI_COMPAT
        require(baseUrl.isNotBlank()) { "baseUrl required" }
        require(modelBaseUrlAllowed(baseUrl)) {
            "baseUrl must use HTTPS, or HTTP on loopback for local testing"
        }
        require(model.isNotBlank()) { "model required" }
        val edit = prefs.edit()
            .putString(KEY_PROTOCOL, parsed.name)
            .putString(KEY_BASE_URL, baseUrl.trim())
            .putString(KEY_MODEL, model.trim())
        if (!apiKey.isNullOrBlank()) {
            edit.putString(KEY_CIPHER, encrypt(apiKey))
        }
        check(edit.commit()) { "could not persist model settings" }
        return read()
    }

    @Synchronized
    fun clear(): JSONObject {
        check(prefs.edit().clear().commit()) { "could not clear model settings" }
        // Delete the wrapping key too: an old ciphertext must not remain
        // decryptable after the user removes the provider configuration.
        runCatching {
            val keyStore = keyStore()
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
        }
        return read()
    }

    /** Returns null when metadata or the API key is missing/unreadable. */
    @Synchronized
    fun modelConfig(): ModelConfig? {
        val protocol = ModelProtocol.fromWire(prefs.getString(KEY_PROTOCOL, null)) ?: return null
        val baseUrl = prefs.getString(KEY_BASE_URL, null)?.takeIf { it.isNotBlank() } ?: return null
        val model = prefs.getString(KEY_MODEL, null)?.takeIf { it.isNotBlank() } ?: return null
        val cipherText = prefs.getString(KEY_CIPHER, null) ?: return null
        val apiKey = runCatching { decrypt(cipherText) }.getOrNull()?.takeIf { it.isNotBlank() } ?: return null
        return ModelConfig(protocol, baseUrl, model, apiKey)
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = ByteArray(cipher.iv.size + encrypted.size)
        cipher.iv.copyInto(packed, 0)
        encrypted.copyInto(packed, cipher.iv.size)
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    private fun decrypt(packed: String): String {
        val bytes = Base64.decode(packed, Base64.NO_WRAP)
        require(bytes.size > 12) { "invalid encrypted value" }
        val iv = bytes.copyOfRange(0, 12)
        val encrypted = bytes.copyOfRange(12, bytes.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val keyStore = keyStore()
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
}
