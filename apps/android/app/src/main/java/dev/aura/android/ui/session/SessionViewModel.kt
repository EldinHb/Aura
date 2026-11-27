package dev.aura.android.ui.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.net.ProtocolJson
import dev.aura.android.net.ServerConnection
import dev.aura.android.protocol.Approval
import dev.aura.android.protocol.ApprovalDecision
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Input
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.StoredEvent
import dev.aura.android.protocol.UserInputRequest
import dev.aura.android.protocol.UserInputResponse
import dev.aura.android.transcript.Transcript
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.coroutines.cancellation.CancellationException

@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModel(
    private val container: AppContainer,
    val serverId: String,
    val sessionId: String,
) : ViewModel() {
    private val connectionFlow = container.connections.map { it[serverId] }

    val connectionState: StateFlow<ConnectionState> = connectionFlow
        .flatMapLatest { it?.state ?: flowOf(ConnectionState.Offline) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ConnectionState.Offline)

    val session: StateFlow<Session?> = connectionFlow
        .flatMapLatest { it?.sessions ?: flowOf(null) }
        .map { list -> list?.firstOrNull { it.id == sessionId } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _transcript = MutableStateFlow<Transcript?>(null)

    /** The transcript; null until the history is loaded. */
    val transcript: StateFlow<Transcript?> = _transcript

    private val _busy = MutableStateFlow(false)

    /** A message is being sent. */
    val sending: StateFlow<Boolean> = _busy

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    /** Live events that came while the history loads, applied after it. */
    private var buffered: MutableList<Event>? = null

    init {
        viewModelScope.launch {
            connectionFlow.flatMapLatest { it?.events ?: flowOf() }.collect { event ->
                if (event.sessionId != sessionId) return@collect
                val buffer = buffered
                if (buffer != null) buffer += event else _transcript.update { it?.apply(event) }
            }
        }
        viewModelScope.launch {
            connectionFlow.flatMapLatest { it?.resyncs ?: flowOf() }.collect { load() }
        }
        load()
    }

    private fun connection(): ServerConnection? = container.connection(serverId)

    /** Loads the history and what waits for the user, then applies what came meanwhile. */
    fun load() {
        val c = connection()?.takeIf { it.state.value is ConnectionState.Online } ?: return
        if (buffered != null) return
        buffered = mutableListOf()
        viewModelScope.launch {
            try {
                val id = buildJsonObject { put("id", JsonPrimitive(sessionId)) }
                val history = async {
                    c.call("session.history", buildJsonObject {
                        put("id", JsonPrimitive(sessionId))
                        put("after_seq", JsonPrimitive(0))
                        put("limit", JsonPrimitive(HISTORY_LIMIT))
                    }, ListSerializer(StoredEvent.serializer()))
                }
                val pending = async { c.call("session.pending", JsonObject(emptyMap()), Pending.serializer()) }
                val events = history.await().mapNotNull { Event.parse(it.event) }
                val waiting = pending.await()
                var t = Transcript.of(events).copy(
                    approvals = waiting.approvals.filter { it.sessionId == sessionId },
                    inputs = waiting.inputs.filter { it.sessionId == sessionId },
                )
                // Text deltas that came meanwhile may already be in the history; the item's completion brings the whole text.
                buffered.orEmpty().filterNot { it is Event.ItemDelta }.forEach { t = t.apply(it) }
                _transcript.value = t
                runCatching { c.call("session.mark_seen", id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.load_failed, listOf(e.message ?: "")))
            } finally {
                buffered = null
            }
        }
    }

    /** Sends [text] to the agent; [onSent] runs once the server took it. */
    fun send(text: String, onSent: () -> Unit) {
        if (text.isBlank() || _busy.value) return
        _busy.value = true
        call(R.string.send_failed, "session.send", buildJsonObject {
            put("id", JsonPrimitive(sessionId))
            put("input", ProtocolJson.encodeToJsonElement(Input.serializer(), Input(text = text.trim())))
        }, onDone = { _busy.value = false }, onSuccess = onSent)
    }

    fun interrupt() = call(R.string.action_failed, "session.interrupt", idParams())

    fun stop() = call(R.string.action_failed, "session.stop", idParams())

    fun respond(approval: Approval, option: String) = call(R.string.action_failed, "session.respond_approval", buildJsonObject {
        put("id", JsonPrimitive(sessionId))
        put("approval_id", JsonPrimitive(approval.id))
        put("decision", ProtocolJson.encodeToJsonElement(ApprovalDecision.serializer(), ApprovalDecision(option = option)))
    }, onSuccess = { _transcript.update { t -> t?.copy(approvals = t.approvals.filterNot { it.id == approval.id }) } })

    fun answer(request: UserInputRequest, answers: Map<String, List<String>>, declined: Boolean = false) =
        call(R.string.action_failed, "session.respond_input", buildJsonObject {
            put("id", JsonPrimitive(sessionId))
            put(
                "response",
                ProtocolJson.encodeToJsonElement(
                    UserInputResponse.serializer(),
                    UserInputResponse(requestId = request.id, answers = if (declined) emptyMap() else answers, declined = declined),
                ),
            )
        }, onSuccess = { _transcript.update { t -> t?.copy(inputs = t.inputs.filterNot { it.id == request.id }) } })

    private fun idParams() = buildJsonObject { put("id", JsonPrimitive(sessionId)) }

    private fun call(
        failure: Int,
        method: String,
        params: JsonElement,
        onDone: () -> Unit = {},
        onSuccess: () -> Unit = {},
    ) {
        val c = connection()
        if (c == null) {
            onDone()
            return
        }
        viewModelScope.launch {
            try {
                c.call(method, params)
                onSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(failure, listOf(e.message ?: "")))
            } finally {
                onDone()
            }
        }
    }

    private companion object {
        const val HISTORY_LIMIT = 5000
    }
}
