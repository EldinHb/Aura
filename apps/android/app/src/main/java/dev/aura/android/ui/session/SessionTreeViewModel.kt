package dev.aura.android.ui.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.protocol.Forest
import dev.aura.android.protocol.Session
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** The sessions a session screen switches between: the leader, then its workers or team, depth first. */
fun sessionTree(sessions: List<Session>, sessionId: String): List<Session> {
    val forest = Forest(sessions)
    val opened = sessions.firstOrNull { it.id == sessionId } ?: return emptyList()
    val leader = forest.leaderOf(opened)
    val workers = forest.liveDescendantsOf(leader.id)
    // A worker opened from elsewhere (the inbox) is shown even when archived.
    val extra = opened.takeIf { it.id != leader.id && workers.none { w -> w.id == it.id } }
    return listOf(leader) + workers + listOfNotNull(extra)
}

@OptIn(ExperimentalCoroutinesApi::class)
class SessionTreeViewModel(container: AppContainer, serverId: String, sessionId: String) : ViewModel() {
    /** The leader of [sessionId] and everyone under it; empty until the sessions are loaded. */
    val tree: StateFlow<List<Session>> = container.connections
        .flatMapLatest { it[serverId]?.sessions ?: flowOf(null) }
        .map { it?.let { list -> sessionTree(list, sessionId) }.orEmpty() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}
