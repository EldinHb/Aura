package dev.aura.android.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.protocol.ProjectGroup
import dev.aura.android.protocol.groupByProject
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
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

    /** Sessions grouped by project; null until loaded. */
    val groups: StateFlow<List<ProjectGroup>?> = connection
        .flatMapLatest { it?.sessions ?: flowOf(null) }
        .map { it?.let(::groupByProject) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

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
