package dev.aura.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The daemon's types (crates/aura-core/src/types.rs), as far as this app uses
// them. Fields it does not read are left out; unknown ones are ignored.

@Serializable
data class WorktreeInfo(
    @SerialName("repo_root") val repoRoot: String,
    val path: String,
    val branch: String,
)

@Serializable
data class Session(
    val id: String,
    val provider: String,
    val agent: String? = null,
    val cwd: String = "",
    val worktree: WorktreeInfo? = null,
    val title: String = "",
    val group: String? = null,
    val status: String = "idle",
    val mode: String = "structured",
    val model: String? = null,
    @SerialName("last_activity") val lastActivity: String = "",
    val archived: Boolean = false,
    val pinned: Boolean = false,
    @SerialName("last_error") val lastError: String? = null,
    @SerialName("pending_count") val pendingCount: Int = 0,
    val attention: String? = null,
    @SerialName("orchestrator_id") val orchestratorId: String? = null,
    @SerialName("specialist_name") val specialistName: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    /** The workspace it is in; empty against a daemon from before workspaces. */
    val workspace: String = "",
    val orchestrator: Boolean = false,
    @SerialName("feature_owner") val featureOwner: Boolean = false,
    /** The scheduled task that started it, when one did. */
    @SerialName("scheduled_task_id") val scheduledTaskId: String? = null,
    @SerialName("scheduled_task_name") val scheduledTaskName: String? = null,
    /** The scheduled task whose run it is part of, set on the run and every worker under it. */
    @SerialName("scheduled_run") val scheduledRun: String? = null,
)

/** A named container the user works in; every session is in one. */
@Serializable
data class Workspace(
    val id: String,
    val name: String,
    val position: Int = 0,
)

@Serializable
data class Turn(
    val id: String,
    @SerialName("session_id") val sessionId: String,
    val status: String,
    val error: String? = null,
)

@Serializable
data class Item(
    val id: String,
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("turn_id") val turnId: String? = null,
    val kind: String,
    val status: String = "completed",
    val title: String? = null,
    val text: String = "",
    val data: JsonObject = JsonObject(emptyMap()),
    @SerialName("parent_id") val parentId: String? = null,
    @SerialName("started_at") val startedAt: String = "",
)

@Serializable
data class Approval(
    val id: String,
    @SerialName("session_id") val sessionId: String,
    val kind: String = "generic",
    val title: String = "",
    val description: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
    val options: List<String> = emptyList(),
)

@Serializable
data class ApprovalDecision(
    val option: String,
    @SerialName("updated_input") val updatedInput: JsonElement? = null,
    val message: String? = null,
)

@Serializable
data class QuestionOption(val label: String, val description: String? = null)

@Serializable
data class Question(
    val id: String,
    val header: String? = null,
    val question: String,
    val options: List<QuestionOption> = emptyList(),
    @SerialName("multi_select") val multiSelect: Boolean = false,
    @SerialName("allow_free_text") val allowFreeText: Boolean = false,
    val secret: Boolean = false,
)

@Serializable
data class UserInputRequest(
    val id: String,
    @SerialName("session_id") val sessionId: String,
    val questions: List<Question> = emptyList(),
)

@Serializable
data class UserInputResponse(
    @SerialName("request_id") val requestId: String,
    val answers: Map<String, List<String>>,
    val declined: Boolean,
)

@Serializable
data class Pending(
    val approvals: List<Approval> = emptyList(),
    val inputs: List<UserInputRequest> = emptyList(),
)

@Serializable
data class Input(
    val text: String,
    val images: List<JsonElement> = emptyList(),
    val steer: Boolean = false,
)

@Serializable
data class StoredEvent(val seq: Long, val event: JsonObject)

@Serializable
data class AgentInfo(
    val id: String,
    @SerialName("display_name") val displayName: String,
    val available: Boolean = false,
)

@Serializable
data class Capabilities(
    val structured: Boolean = true,
    val models: Boolean = false,
    val effort: Boolean = false,
    @SerialName("permission_modes") val permissionModes: List<String> = emptyList(),
    @SerialName("sandbox_modes") val sandboxModes: List<String> = emptyList(),
)

/** A model a provider offers (`provider.models`). */
@Serializable
data class ModelInfo(
    val id: String,
    @SerialName("display_name") val displayName: String = id,
    val description: String? = null,
    val efforts: List<String> = emptyList(),
    @SerialName("default_effort") val defaultEffort: String? = null,
    @SerialName("is_default") val isDefault: Boolean = false,
)

/** How much a feature owner decides on its own; checkpoints apply at `checkpoints`. */
@Serializable
data class Autonomy(val level: String, val checkpoints: List<String> = emptyList()) {
    companion object {
        const val AUTONOMOUS = "autonomous"
        const val BLOCKING = "blocking_decisions"
        const val CHECKPOINTS = "checkpoints"
        val ALL_CHECKPOINTS = listOf("after_design", "before_implementation", "before_delivery")

        /** What the desktop starts a feature's own autonomy at. */
        val DEFAULT = Autonomy(BLOCKING, ALL_CHECKPOINTS)
    }
}

/** A worktree for a new session: a branch, made under the repository's `.aura-worktrees/`. */
@Serializable
data class WorktreeOpts(val branch: String, val base: String? = null)

@Serializable
data class ProviderInfo(
    val kind: String,
    @SerialName("display_name") val displayName: String,
    val available: Boolean = false,
    val capabilities: Capabilities = Capabilities(),
    val agents: List<AgentInfo> = emptyList(),
)

@Serializable
data class Project(
    val path: String,
    val repo: Boolean = false,
    val sessions: Int = 0,
    @SerialName("last_used") val lastUsed: String = "",
)

@Serializable
data class CreateSessionOpts(
    val provider: String,
    val agent: String? = null,
    val cwd: String,
    @SerialName("initial_prompt") val initialPrompt: String? = null,
    /** The workspace to start it in; null leaves it to the server (the one last active). */
    val workspace: String? = null,
    val title: String? = null,
    val group: String? = null,
    val model: String? = null,
    val effort: String? = null,
    @SerialName("permission_mode") val permissionMode: String? = null,
    @SerialName("sandbox_mode") val sandboxMode: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    val worktree: WorktreeOpts? = null,
    val orchestrator: Boolean = false,
    @SerialName("feature_owner") val featureOwner: Boolean = false,
    @SerialName("feature_goal") val featureGoal: String? = null,
    val autonomy: Autonomy? = null,
)

/** `remote.pair`'s answer. */
@Serializable
data class PairResult(
    val deviceId: String,
    val token: String,
    val serverId: String,
    val serverName: String,
    val version: String = "",
)

/** `remote.auth`'s answer. */
@Serializable
data class AuthResult(
    val serverId: String,
    val serverName: String,
    val version: String = "",
)

/** A question a feature owner put to the user (`ask_user` or a checkpoint). */
@Serializable
data class UserQuestion(
    val id: String,
    val question: String,
    val context: String = "",
    val options: List<QuestionOption> = emptyList(),
    val recommended: String? = null,
    val kind: String = "decision",
    @SerialName("asked_at") val askedAt: String = "",
    val answer: QuestionAnswer? = null,
    val withdrawn: Boolean = false,
) {
    /** Still waiting for the user's answer. */
    val open: Boolean get() = answer == null && !withdrawn
}

/** The user's answer to a feature owner's question: an option, words of their own, or both. */
@Serializable
data class QuestionAnswer(val option: String? = null, val text: String = "")

/** A feature a feature owner session runs, as far as the app shows it. */
@Serializable
data class Feature(
    @SerialName("owner_id") val ownerId: String,
    val goal: String = "",
    val status: String = "",
    val questions: List<UserQuestion> = emptyList(),
    @SerialName("updated_at") val updatedAt: String = "",
)
