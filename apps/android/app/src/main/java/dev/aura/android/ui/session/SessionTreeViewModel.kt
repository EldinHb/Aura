package dev.aura.android.ui.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.protocol.Forest
import dev.aura.android.protocol.Session
import kotlinx.coroutines.ExperimentalCoroutinesApi
import dev.aura.android.protocol.Feature
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException
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
class SessionTreeViewModel(private val container: AppContainer, private val serverId: String, sessionId: String) : ViewModel() {
    private val connection = container.connections.map { it[serverId] }

    /** The leader of [sessionId] and everyone under it; empty until the sessions are loaded. */
    val tree: StateFlow<List<Session>> = connection
        .flatMapLatest { it?.sessions ?: flowOf(null) }
        .map { it?.let { list -> sessionTree(list, sessionId) }.orEmpty() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** The feature the leader owns, when it is a feature owner. */
    val feature: StateFlow<Feature?> = combine(connection.flatMapLatest { it?.features ?: flowOf(null) }, tree) { features, tree ->
        tree.firstOrNull()?.let { leader -> features?.firstOrNull { it.ownerId == leader.id } }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Each session's latest reply, as far as known. */
    val replies: StateFlow<Map<String, String>> = connection
        .flatMapLatest { it?.lastReplies ?: flowOf(emptyMap()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyMap())

    /** Reads the latest reply of each of [ids] not seen live yet, for the team view. */
    fun loadReplies(ids: List<String>) {
        val c = container.connection(serverId) ?: return
        viewModelScope.launch {
            for (id in ids) {
                try {
                    c.loadLastReply(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    // The row shows without its last line.
                }
            }
        }
    }
}
