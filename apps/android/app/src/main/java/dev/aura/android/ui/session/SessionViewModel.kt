package dev.aura.android.ui.session

import android.graphics.Bitmap
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.images.DraftImage
import dev.aura.android.images.ImageLimits
import dev.aura.android.images.decodeImage
import dev.aura.android.net.ConnectionState
import dev.aura.android.net.ProtocolJson
import dev.aura.android.net.ServerConnection
import dev.aura.android.protocol.Approval
import dev.aura.android.protocol.ApprovalDecision
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Input
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.StoredEvent
import dev.aura.android.protocol.UserInputRequest
import dev.aura.android.protocol.UserInputResponse
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.protocol.Workspace
import dev.aura.android.transcript.Transcript
import dev.aura.android.transcript.fetchHistory
import dev.aura.android.transcript.reconcile
import dev.aura.android.ui.components.UiMessage
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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

    /** The feature this session owns, when it is a feature owner: its questions are cards in the chat. */
    val feature: StateFlow<Feature?> = connectionFlow
        .flatMapLatest { it?.features ?: flowOf(null) }
        .map { list -> list?.firstOrNull { it.ownerId == sessionId } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** The server's workspaces, for "Move to workspace"; empty against a daemon without them. */
    val workspaces: StateFlow<List<Workspace>> = connectionFlow
        .flatMapLatest { it?.workspaces ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Moves [leaderId] and its workers to [workspace], or to a new workspace named [newName]. */
    fun moveToWorkspace(leaderId: String, workspace: String?, newName: String? = null) {
        val c = connection() ?: return
        viewModelScope.launch {
            try {
                val target = workspace?.let { id -> workspaces.value.first { it.id == id } } ?: c.createWorkspace(newName!!)
                c.moveToWorkspace(leaderId, target.id)
                _messages.trySend(UiMessage.Res(R.string.moved_to_workspace, listOf(target.name)))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.action_failed, listOf(e.message ?: "")))
            }
        }
    }

    private val _answering = MutableStateFlow<Set<String>>(emptySet())

    /** The feature questions whose answer is on its way. */
    val answering: StateFlow<Set<String>> = _answering

    /** Answers the feature owner's [question] here, as the inbox does. */
    fun answerFeature(question: UserQuestion, option: String?, text: String) {
        val c = connection() ?: return
        if (question.id in _answering.value) return
        _answering.update { it + question.id }
        viewModelScope.launch {
            try {
                c.answerFeatureQuestion(sessionId, question.id, option, text.trim())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.action_failed, listOf(e.message ?: "")))
            } finally {
                _answering.update { it - question.id }
            }
        }
    }

    private val _drafts = MutableStateFlow<List<DraftImage>>(emptyList())

    /** Images picked for the next message, ready to send. */
    val drafts: StateFlow<List<DraftImage>> = _drafts

    private val _preparing = MutableStateFlow(0)

    /** Images still being read and shrunk. */
    val preparing: StateFlow<Int> = _preparing

    private val _busy = MutableStateFlow(false)

    /** A message is being sent. */
    val sending: StateFlow<Boolean> = _busy

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    /** Live events (as received) that came while the history loads, applied after it. */
    private var buffered: MutableList<JsonObject>? = null

    init {
        // Images shared into this session from another app go into its composer.
        container.sharedImages.value["$serverId/$sessionId"]?.let { shared ->
            container.sharedImages.update { it - "$serverId/$sessionId" }
            viewModelScope.launch {
                session.first { it != null }
                addImages(shared)
            }
        }
        viewModelScope.launch {
            connectionFlow.flatMapLatest { it?.events ?: flowOf() }.collect { live ->
                if (live.event.sessionId != sessionId) return@collect
                val buffer = buffered
                if (buffer != null) buffer += live.raw else _transcript.update { it?.apply(live.event) }
            }
        }
        viewModelScope.launch {
            connectionFlow.flatMapLatest { it?.resyncs ?: flowOf() }.collect { load() }
        }
        load()
    }

    private fun connection(): ServerConnection? = container.connection(serverId)

    /** Loads the whole history and what waits for the user, then applies what came meanwhile. */
    fun load() {
        val c = connection()?.takeIf { it.state.value is ConnectionState.Online } ?: return
        if (buffered != null) return
        buffered = mutableListOf()
        viewModelScope.launch {
            try {
                // A failure of either call ends here, not in the view model's scope.
                val (history, pending) = coroutineScope {
                    val history = async {
                        fetchHistory { after, limit ->
                            c.call("session.history", buildJsonObject {
                                put("id", JsonPrimitive(sessionId))
                                put("after_seq", JsonPrimitive(after))
                                put("limit", JsonPrimitive(limit))
                            }, ListSerializer(StoredEvent.serializer()))
                        }
                    }
                    val pending = async { c.call("session.pending", JsonObject(emptyMap()), Pending.serializer()) }
                    history.await() to pending.await()
                }
                // Applied and cleared at once: anything that comes from here on goes straight in.
                _transcript.value = reconcile(history, pending, sessionId, buffered.orEmpty())
                buffered = null
            } catch (e: CancellationException) {
                buffered = null
                throw e
            } catch (e: Throwable) {
                buffered = null
                _messages.trySend(UiMessage.Res(R.string.load_failed, listOf(e.message ?: "")))
                return@launch
            }
            try {
                c.call("session.mark_seen", buildJsonObject { put("id", JsonPrimitive(sessionId)) })
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // Seen or not, the transcript is shown; the next open marks it.
            }
        }
    }

    /** Sends [text] to the agent; [onSent] runs once the server took it. */
    fun send(text: String, onSent: () -> Unit) {
        val images = _drafts.value
        if ((text.isBlank() && images.isEmpty()) || _busy.value || _preparing.value > 0) return
        _busy.value = true
        call(R.string.send_failed, "session.send", buildJsonObject {
            put("id", JsonPrimitive(sessionId))
            put("input", ProtocolJson.encodeToJsonElement(Input.serializer(), Input(text = text.trim(), images = images.map { it.input })))
        }, onDone = { _busy.value = false }, onSuccess = {
            _drafts.update { it - images.toSet() }
            onSent()
        })
    }

    /** Text for the composer from elsewhere ("Ask for changes"), until it takes it. */
    val prefill: StateFlow<String?> = container.composerPrefill
        .map { it["$serverId/$sessionId"] }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    fun takePrefill() {
        container.composerPrefill.update { it - "$serverId/$sessionId" }
    }

    /** Reads [uris] and shrinks them to what this session's agent takes, off the main thread. */
    fun addImages(uris: List<Uri>) {
        val limits = ImageLimits.forProvider(session.value?.provider)
        for (uri in uris) {
            if (_drafts.value.any { it.id == uri.toString() }) continue
            _preparing.update { it + 1 }
            viewModelScope.launch {
                try {
                    val draft = withContext(Dispatchers.IO) { container.images.encode(uri, limits) }
                    _drafts.update { it + draft }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    _messages.trySend(UiMessage.Res(R.string.image_failed, listOf(e.message ?: "")))
                } finally {
                    _preparing.update { it - 1 }
                }
            }
        }
    }

    fun removeImage(id: String) {
        _drafts.update { list -> list.filterNot { it.id == id } }
    }

    /** A sent image the daemon kept, whole; null when it cannot be loaded. */
    suspend fun loadAttachment(attachment: String): Bitmap? = runCatching {
        val c = connection() ?: return null
        val result = c.call("session.attachment", buildJsonObject {
            put("id", JsonPrimitive(sessionId))
            put("attachment", JsonPrimitive(attachment))
        })
        val data = ((result as? JsonObject)?.get("data") as? JsonPrimitive)?.content ?: return null
        withContext(Dispatchers.Default) { decodeImage(data) }
    }.getOrNull()

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

}
