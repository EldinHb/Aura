package dev.aura.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Session templates (crates/aura-core/src/templates.rs): snake_case on the wire.

/** A saved set of new-session options, shared with the desktop (`template.list`). */
@Serializable
data class SessionTemplate(
    val id: String,
    val name: String,
    /** `agent`, `orchestrator` or `feature_owner`. */
    val kind: String = "agent",
    val provider: String,
    val agent: String? = null,
    val cwd: String? = null,
    val worktree: Boolean = false,
    @SerialName("branch_pattern") val branchPattern: String? = null,
    val workspace: String? = null,
    val group: String? = null,
    val mode: String? = null,
    val model: String? = null,
    val effort: String? = null,
    @SerialName("permission_mode") val permissionMode: String? = null,
    @SerialName("sandbox_mode") val sandboxMode: String? = null,
    val autonomy: Autonomy? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    val prompt: String? = null,
    @SerialName("updated_at") val updatedAt: String = "",
) {
    /** Whether the phone can start it: no terminals here. */
    val startableHere: Boolean get() = provider != "terminal" && mode != "terminal"
}

/** What `template.create` takes. */
@Serializable
data class TemplateInput(
    val name: String,
    val kind: String = "agent",
    val provider: String,
    val agent: String? = null,
    val cwd: String? = null,
    val worktree: Boolean = false,
    @SerialName("branch_pattern") val branchPattern: String? = null,
    val workspace: String? = null,
    val group: String? = null,
    val model: String? = null,
    val effort: String? = null,
    @SerialName("permission_mode") val permissionMode: String? = null,
    @SerialName("sandbox_mode") val sandboxMode: String? = null,
    val autonomy: Autonomy? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    val prompt: String? = null,
)
