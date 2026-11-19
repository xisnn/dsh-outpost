package com.dshpocket.runtime.install

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * P4-0.3 #43: wire the previously orphaned device-only installer security checks
 * (RuntimeInstallerChecks: 0 @Test, no callers) into the androidTest suite so they
 * actually execute. Pure fixtures under cacheDir; no production installer change;
 * no isolated-package or libproot requirement (unlike LocalRuntimeBridgeValidationTest).
 */
@RunWith(AndroidJUnit4::class)
class RuntimeInstallerChecksTest {
    @Test
    fun installerSecurityChecksPassOnDevice() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val result = RuntimeInstallerChecks.run(context.cacheDir)
        assertTrue("installer checks must report ok", result.getBoolean("ok"))
        // Pin the check-group count (19 groups as of P4-0.3); strengthen when checks grow.
        assertEquals(19, result.getInt("count"))
        File(context.getExternalFilesDir(null), "p403-installer-checks.json").writeText(result.toString(2))
    }
}
