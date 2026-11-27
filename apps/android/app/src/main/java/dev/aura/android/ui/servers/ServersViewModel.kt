package dev.aura.android.ui.servers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.data.SavedServer
import dev.aura.android.net.ConnectionState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class ServerUi(val server: SavedServer, val state: ConnectionState)

/** The states of all connections, by server id. */
@OptIn(ExperimentalCoroutinesApi::class)
fun AppContainer.connectionStates() = connections.flatMapLatest { map ->
    if (map.isEmpty()) {
        flowOf(emptyMap())
    } else {
        combine(map.map { (id, c) -> c.state.map { id to it } }) { it.toMap() }
    }
}

class ServersViewModel(private val container: AppContainer) : ViewModel() {
    /** Saved servers with their connection state; null while loading. */
    val servers: StateFlow<List<ServerUi>?> = combine(container.store.servers, container.connectionStates()) { saved, states ->
        saved.map { ServerUi(it, states[it.id] ?: ConnectionState.Offline) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    fun rename(id: String, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch { container.store.rename(id, trimmed) }
    }

    fun remove(id: String) {
        viewModelScope.launch { container.store.remove(id) }
    }

    fun reconnect(id: String) {
        container.connection(id)?.retryNow()
    }
}
