package dev.aura.android.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.protocol.SessionList
import dev.aura.android.protocol.sessionList
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

@OptIn(ExperimentalCoroutinesApi::class)
class SessionsViewModel(private val container: AppContainer, val serverId: String) : ViewModel() {
    private val connection = container.connections.map { it[serverId] }

    val serverName: StateFlow<String> = container.store.servers
        .map { list -> list.firstOrNull { it.id == serverId }?.name.orEmpty() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), "")

    val state: StateFlow<ConnectionState> = connection
        .flatMapLatest { it?.state ?: flowOf(ConnectionState.Offline) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ConnectionState.Offline)

    /** The sessions as the desktop sidebar lays them out; null until loaded. */
    val list: StateFlow<SessionList?> = connection
        .flatMapLatest { c -> c?.let { combine(it.sessions, it.workspaces) { s, w -> s?.let { sessionList(it, w) } } } ?: flowOf(null) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** The keys of the groups the user folded. */
    val folded: StateFlow<Set<String>> = container.folded.of(serverId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptySet())

    /** Makes a workspace; its sessions then go there by "Move to workspace". */
    fun createWorkspace(name: String) {
        val c = container.connection(serverId) ?: return
        viewModelScope.launch {
            try {
                val made = c.createWorkspace(name)
                _messages.trySend(UiMessage.Res(R.string.workspace_created, listOf(made.name)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.action_failed, listOf(e.message ?: "")))
            }
        }
    }

    fun toggle(group: String) {
        viewModelScope.launch { container.folded.toggle(serverId, group) }
    }

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    fun refresh() {
        val c = container.connection(serverId) ?: return
        if (c.state.value !is ConnectionState.Online) {
            c.retryNow()
            return
        }
        viewModelScope.launch {
            _refreshing.value = true
            try {
                c.refreshSessions()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.refresh_failed, listOf(e.message ?: "")))
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun retry() {
        container.connection(serverId)?.retryNow()
    }
}
