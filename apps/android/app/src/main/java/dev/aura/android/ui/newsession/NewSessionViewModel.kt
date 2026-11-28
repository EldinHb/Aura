package dev.aura.android.ui.newsession

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.CreateSessionOpts
import dev.aura.android.protocol.Project
import dev.aura.android.protocol.ProviderInfo
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.Workspace
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException

/** An agent a session can run: a provider, and for ACP one of its agents. */
data class AgentChoice(val provider: String, val agent: String?, val name: String)

data class NewSessionOptions(val projects: List<Project>, val agents: List<AgentChoice>, val workspaces: List<Workspace> = emptyList())

/** The agents that can run a structured session, from the server's providers. */
fun agentChoices(providers: List<ProviderInfo>): List<AgentChoice> = providers
    .filter { it.available && it.kind != "terminal" && it.capabilities.structured }
    .flatMap { p ->
        if (p.kind == "acp") {
            p.agents.filter { it.available }.map { AgentChoice(p.kind, it.id, it.displayName) }
        } else {
            listOf(AgentChoice(p.kind, null, p.displayName))
        }
    }

class NewSessionViewModel(private val container: AppContainer, private val serverId: String) : ViewModel() {
    private val _options = MutableStateFlow<NewSessionOptions?>(null)

    /** Projects and agents to choose from; null while loading. */
    val options: StateFlow<NewSessionOptions?> = _options

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
                _options.value = coroutineScope {
                    val projects = async { c.call("orchestrator.projects", JsonObject(emptyMap()), ListSerializer(Project.serializer())) }
                    val providers = async { c.call("provider.list", JsonObject(emptyMap()), ListSerializer(ProviderInfo.serializer())) }
                    NewSessionOptions(
                        projects = projects.await().sortedByDescending { it.lastUsed },
                        agents = agentChoices(providers.await()),
                        workspaces = c.workspaces.value,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // The workspaces are known from the connection whatever failed here.
                _options.value = NewSessionOptions(emptyList(), emptyList(), c.workspaces.value)
                _messages.trySend(UiMessage.Res(R.string.load_failed, listOf(e.message ?: "")))
            }
        }
    }

    fun create(project: String, agent: AgentChoice, prompt: String, workspace: String?) {
        val c = container.connection(serverId) ?: return
        if (_creating.value) return
        _creating.value = true
        viewModelScope.launch {
            try {
                val opts = CreateSessionOpts(
                    provider = agent.provider,
                    agent = agent.agent,
                    cwd = project.trim(),
                    initialPrompt = prompt.trim().ifEmpty { null },
                    workspace = workspace,
                )
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
