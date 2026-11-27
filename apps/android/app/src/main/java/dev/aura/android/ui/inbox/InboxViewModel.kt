package dev.aura.android.ui.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.SessionState
import dev.aura.android.protocol.state
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** A session waiting on the user, on one of the servers. */
data class WaitingSession(val serverId: String, val serverName: String, val session: Session)

/** Sessions waiting on the user across every connected server, latest first. */
@OptIn(ExperimentalCoroutinesApi::class)
fun AppContainer.waitingSessions(): Flow<List<WaitingSession>> =
    combine(store.servers, connections.flatMapLatest { map ->
        if (map.isEmpty()) {
            flowOf(emptyMap())
        } else {
            combine(map.map { (id, c) -> c.sessions.map { id to it.orEmpty() } }) { it.toMap() }
        }
    }) { servers, sessions ->
        servers.flatMap { server ->
            sessions[server.id].orEmpty()
                .filter { !it.archived && it.state == SessionState.Waiting }
                .map { WaitingSession(server.id, server.name, it) }
        }.sortedByDescending { it.session.lastActivity }
    }

class InboxViewModel(container: AppContainer) : ViewModel() {
    val waiting: StateFlow<List<WaitingSession>?> = container.waitingSessions()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
}
