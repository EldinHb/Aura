package dev.aura.android.ui.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.data.SavedServer
import dev.aura.android.net.ServerConnection
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.SessionState
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.protocol.state
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/** A session waiting on the user, on one of the servers. */
data class WaitingSession(val serverId: String, val serverName: String, val session: Session)

/** A feature owner's open question to the user, on one of the servers. */
data class WaitingQuestion(val serverId: String, val serverName: String, val feature: Feature, val question: UserQuestion) {
    val key: String get() = "$serverId:${feature.ownerId}:${question.id}"
}

/** What waits on the user across every connected server. */
data class Inbox(val questions: List<WaitingQuestion>, val sessions: List<WaitingSession>) {
    val size: Int get() = questions.size + sessions.size
}

internal data class ServerSnapshot(val sessions: List<Session>, val features: List<Feature>)

/** Collects what waits on the user from [servers] and their [snapshots]. */
internal fun inboxOf(servers: List<SavedServer>, snapshots: Map<String, ServerSnapshot>): Inbox {
    val questions = servers.flatMap { server ->
        snapshots[server.id]?.features.orEmpty().flatMap { feature ->
            feature.questions.filter { it.open }.map { WaitingQuestion(server.id, server.name, feature, it) }
        }
    }.sortedByDescending { it.question.askedAt }
    val sessions = servers.flatMap { server ->
        snapshots[server.id]?.sessions.orEmpty()
            .filter { !it.archived && it.state == SessionState.Waiting }
            .map { WaitingSession(server.id, server.name, it) }
    }.sortedByDescending { it.session.lastActivity }
    return Inbox(questions, sessions)
}

/** Sessions and feature owners' questions waiting on the user, across every connected server. */
@OptIn(ExperimentalCoroutinesApi::class)
fun AppContainer.inbox(): Flow<Inbox> =
    combine(store.servers, connections.flatMapLatest { map ->
        if (map.isEmpty()) {
            flowOf(emptyMap())
        } else {
            combine(map.map { (id, c) -> c.snapshot(id) }) { it.toMap() }
        }
    }, ::inboxOf)

private fun ServerConnection.snapshot(id: String) =
    combine(sessions, features) { s, f -> id to ServerSnapshot(s.orEmpty(), f.orEmpty()) }

class InboxViewModel(private val container: AppContainer) : ViewModel() {
    val inbox: StateFlow<Inbox?> = container.inbox()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _answering = MutableStateFlow<Set<String>>(emptySet())

    /** Questions whose answer is on its way, by [WaitingQuestion.key]. */
    val answering: StateFlow<Set<String>> = _answering

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    fun answer(waiting: WaitingQuestion, option: String?, text: String) {
        val c = container.connection(waiting.serverId) ?: return
        if (waiting.key in _answering.value) return
        _answering.update { it + waiting.key }
        viewModelScope.launch {
            try {
                c.answerFeatureQuestion(waiting.feature.ownerId, waiting.question.id, option, text.trim())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.action_failed, listOf(e.message ?: "")))
            } finally {
                _answering.update { it - waiting.key }
            }
        }
    }
}
