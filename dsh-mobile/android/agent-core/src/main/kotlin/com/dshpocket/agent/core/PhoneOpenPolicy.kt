package com.dshpocket.agent.core

/**
 * P4-0.1 P0-3B: decide phone_open refusals BEFORE the target is launched.
 *
 * The previous flow launched the target first and only then noticed it was a
 * system/security settings package, i.e. the sensitive page was already on
 * screen (and possibly already interacted with by the user) before the tool
 * reported DENIED. A refusal that happens after the side effect is not a
 * refusal.
 *
 * This policy is reject-only: it can turn a launch into a pre-launch denial,
 * never the other way round. Post-launch sensitive-screen guards stay in place
 * as a second layer for targets whose sensitivity is only visible once drawn.
 */
object PhoneOpenPolicy {
    /**
     * @return a refusal reason when the launch must not happen, null otherwise.
     * `sensitiveTarget` is the caller's pre-launch classification of the package
     * (system/security settings etc.). `locked` is the pre-launch keyguard state.
     */
    fun preLaunchRefusal(packageName: String?, sensitiveTarget: Boolean, locked: Boolean): String? {
        if (packageName.isNullOrBlank()) return "INVALID_PACKAGE"
        if (locked) return "SCREEN_LOCKED: unlock the phone first"
        if (sensitiveTarget) {
            return "OPEN_SENSITIVE_PACKAGE: $packageName is a system or security settings target; " +
                "it was not launched"
        }
        return null
    }
}