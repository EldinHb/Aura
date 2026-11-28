package dev.aura.android.ui.newsession

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Autonomy
import dev.aura.android.protocol.CreateSessionOpts
import dev.aura.android.protocol.ModelInfo
import dev.aura.android.protocol.Project
import dev.aura.android.protocol.ProviderInfo
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.Workspace
import dev.aura.android.protocol.WorktreeOpts
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import kotlin.coroutines.cancellation.CancellationException

/** An agent a session can run: a provider, and for ACP one of its agents. */
data class AgentChoice(val provider: String, val agent: String?, val name: String, val info: ProviderInfo? = null)

/** The agents that can run a structured session, from the server's providers. */
fun agentChoices(providers: List<ProviderInfo>): List<AgentChoice> = providers
    .filter { it.available && it.kind != "terminal" && it.capabilities.structured }
    .flatMap { p ->
        if (p.kind == "acp") {
            p.agents.filter { it.available }.map { AgentChoice(p.kind, it.id, it.displayName, p) }
        } else {
            listOf(AgentChoice(p.kind, null, p.displayName, p))
        }
    }

/** What kind of session to start, as the desktop's dialog offers. */
enum class SessionKind { Agent, Orchestrator, FeatureOwner }

/** What the server offers to choose from; loaded once. */
data class NewSessionOptions(
    val projects: List<Project>,
    val agents: List<AgentChoice>,
    val workspaces: List<Workspace> = emptyList(),
)

/** The form, as the desktop's new-session dialog has it, with its defaults. */
data class NewSessionForm(
    val kind: SessionKind = SessionKind.Agent,
    val agentIndex: Int = 0,
    val project: String = "",
    /** An orchestrator has no folder unless the user gives it one. */
    val orchestratorFolder: Boolean = false,
    val title: String = "",
    val group: String = "",
    val model: String = "",
    val effort: String = "",
    val permission: String = "",
    val sandbox: String = "",
    val worktree: Boolean = false,
    val branch: String = "",
    val branchTouched: Boolean = false,
    val prompt: String = "",
    val systemPrompt: String = "",
    val goal: String = "",
    /** The feature's own autonomy; null follows the server's setting for every feature owner. */
    val autonomy: Autonomy? = null,
    val workspace: String? = null,
) {
    val orchestrates: Boolean get() = kind != SessionKind.Agent
    val noFolder: Boolean get() = orchestrates && !orchestratorFolder
}

/** "aura/" and the title as a branch name, or the time when there is no title (as the desktop names it). */
fun defaultBranch(title: String, now: LocalDateTime = LocalDateTime.now()): String {
    val slug = title.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(40).trimEnd('-')
    return "aura/" + slug.ifEmpty { now.format(DateTimeFormatter.ofPattern("yyyyMMddHHmm")) }
}

/** The create request for [form], as the desktop sends it. */
fun createOpts(form: NewSessionForm, agent: AgentChoice, isRepo: Boolean): CreateSessionOpts {
    val owns = form.kind == SessionKind.FeatureOwner
    val prompt = (if (owns) form.goal else form.prompt).trim().ifEmpty { null }
    return CreateSessionOpts(
        provider = agent.provider,
        agent = agent.agent,
        // An empty folder gives an orchestrator none: the daemon makes it one of its own.
        cwd = if (form.noFolder) "" else form.project.trim(),
        initialPrompt = prompt,
        workspace = form.workspace,
        title = form.title.trim().ifEmpty { null },
        group = form.group.trim().ifEmpty { null },
        model = form.model.ifEmpty { null },
        effort = form.effort.ifEmpty { null },
        permissionMode = form.permission.ifEmpty { null },
        sandboxMode = form.sandbox.ifEmpty { null },
        systemPrompt = form.systemPrompt.takeIf { it.isNotBlank() },
        worktree = if (!form.noFolder && form.worktree && isRepo && form.branch.isNotBlank()) WorktreeOpts(form.branch.trim()) else null,
        orchestrator = form.orchestrates,
        featureOwner = owns,
        featureGoal = if (owns) form.goal.trim().ifEmpty { null } else null,
        autonomy = if (owns) form.autonomy else null,
    )
}

class NewSessionViewModel(private val container: AppContainer, private val serverId: String) : ViewModel() {
    private val _options = MutableStateFlow<NewSessionOptions?>(null)

    /** Projects and agents to choose from; null while loading. */
    val options: StateFlow<NewSessionOptions?> = _options

    private val _form = MutableStateFlow(NewSessionForm())
    val form: StateFlow<NewSessionForm> = _form

    private val _models = MutableStateFlow<Map<String, List<ModelInfo>>>(emptyMap())

    /** The models of each provider, once loaded. */
    val models: StateFlow<Map<String, List<ModelInfo>>> = _models

    private val _creating = MutableStateFlow(false)
    val creating: StateFlow<Boolean> = _creating

    private val _created = Channel<String>(Channel.BUFFERED)

    /** The id of the session once created. */
    val created = _created.receiveAsFlow()

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    init {
        load()
    }

    fun load() {
        val c = container.connection(serverId) ?: return
        viewModelScope.launch {
            try {
                // A failure of either call ends here, not in the view model's scope.
                val loaded = coroutineScope {
                    val projects = async { c.call("orchestrator.projects", JsonObject(emptyMap()), ListSerializer(Project.serializer())) }
                    val providers = async { c.call("provider.list", JsonObject(emptyMap()), ListSerializer(ProviderInfo.serializer())) }
                    NewSessionOptions(
                        projects = projects.await().sortedByDescending { it.lastUsed },
                        agents = agentChoices(providers.await()),
                        workspaces = c.workspaces.value,
                    )
                }
                _options.value = loaded
                _form.update { f -> if (f.project.isEmpty()) f.copy(project = loaded.projects.firstOrNull()?.path.orEmpty()) else f }
                loaded.agents.firstOrNull()?.let { loadModels(it.provider) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // The workspaces are known from the connection whatever failed here.
                _options.value = NewSessionOptions(emptyList(), emptyList(), c.workspaces.value)
                _messages.trySend(UiMessage.Res(R.string.load_failed, listOf(e.message ?: "")))
            }
        }
    }

    fun edit(change: (NewSessionForm) -> NewSessionForm) {
        val before = _form.value
        _form.update { f ->
            var next = change(f)
            // A new agent starts at its own defaults.
            if (next.agentIndex != before.agentIndex) next = next.copy(model = "", effort = "", permission = "", sandbox = "")
            if (next.model != before.model) next = next.copy(effort = "")
            // Until the user edits the branch, it follows the title.
            if (!next.branchTouched && (next.title != before.title || (next.worktree && next.branch.isEmpty()))) {
                next = next.copy(branch = if (next.worktree || next.title.isNotBlank()) defaultBranch(next.title) else "")
            }
            next
        }
        _options.value?.agents?.getOrNull(_form.value.agentIndex)?.let { loadModels(it.provider) }
    }

    private fun loadModels(provider: String) {
        if (provider == "acp" || provider in _models.value) return
        val c = container.connection(serverId) ?: return
        _models.update { it + (provider to emptyList()) }
        viewModelScope.launch {
            try {
                val list = c.call("provider.models", buildJsonObject { put("provider", JsonPrimitive(provider)) }, ListSerializer(ModelInfo.serializer()))
                _models.update { it + (provider to list) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // No models: the agent's default is used, as on the desktop when listing fails.
            }
        }
    }

    fun create() {
        val c = container.connection(serverId) ?: return
        val o = _options.value ?: return
        val form = _form.value
        val agent = o.agents.getOrNull(form.agentIndex) ?: return
        if (_creating.value) return
        _creating.value = true
        viewModelScope.launch {
            try {
                val isRepo = o.projects.firstOrNull { form.project.trim().startsWith(it.path) }?.repo == true
                val opts = createOpts(form, agent, isRepo)
                val session = c.call("session.create", ProtocolJson.encodeToJsonElement(CreateSessionOpts.serializer(), opts), Session.serializer())
                _created.send(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.create_failed, listOf(e.message ?: "")))
            } finally {
                _creating.value = false
            }
        }
    }
}
