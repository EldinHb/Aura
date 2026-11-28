package dev.aura.android.net

import dev.aura.android.data.SavedServer
import dev.aura.android.protocol.AuthResult
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.Workspace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import kotlin.coroutines.cancellation.CancellationException

/** An event as the server sent it: parsed, and the JSON it came as. */
data class LiveEvent(val event: Event, val raw: JsonObject)

/** Where a server connection stands. */
sealed interface ConnectionState {
    /** Not connecting: the app is in the background, or the connection was not started. */
    data object Offline : ConnectionState

    data object Connecting : ConnectionState

    data class Online(val serverName: String, val version: String) : ConnectionState

    /** The last attempt failed; the next one starts at [retryAt] (epoch millis), or sooner on [ServerConnection.retryNow]. */
    data class Retrying(val reason: String, val retryAt: Long) : ConnectionState

    /** The server no longer accepts this device: it was removed there, or its token is lost here. Pair again. */
    data class Revoked(val reason: String) : ConnectionState

    /** The server showed another certificate than the one paired with. Never accepted; pair again to trust a new one. */
    data class CertificateMismatch(val expected: String, val actual: String) : ConnectionState
}

/**
 * The connection to one saved server: connects, authenticates, keeps the
 * session list current from the server's events, and reconnects with backoff
 * until it is stopped, the device is revoked or the certificate changes.
 */
class ServerConnection(
    val server: SavedServer,
    private val token: String?,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Offline)
    val state: StateFlow<ConnectionState> = _state

    // A session's or feature's update carries its time; one from before a reload does not undo it.
    private val sessionList = LiveList<Session>({ it.id }) { incoming, existing -> incoming.lastActivity >= existing.lastActivity }
    private val featureList = LiveList<Feature>({ it.ownerId }) { incoming, existing -> incoming.updatedAt >= existing.updatedAt }

    /** The server's sessions; null until first loaded. */
    val sessions: StateFlow<List<Session>?> = sessionList.items

    /** The server's features, with their owners' questions to the user; null until first loaded. */
    val features: StateFlow<List<Feature>?> = featureList.items

    private val _workspaces = MutableStateFlow<List<Workspace>>(emptyList())

    /** The server's workspaces, in the user's order; empty against a daemon without them. */
    val workspaces: StateFlow<List<Workspace>> = _workspaces

    private val _pending = MutableStateFlow<Pending?>(null)

    /** Approvals and questions waiting on the user, in every session; null until first loaded. */
    val pending: StateFlow<Pending?> = _pending

    private val _lastReplies = MutableStateFlow<Map<String, String>>(emptyMap())

    /** The latest agent message of each session, as seen live, for notification previews. */
    val lastReplies: StateFlow<Map<String, String>> = _lastReplies

    private val _events = MutableSharedFlow<LiveEvent>(extraBufferCapacity = 4096)

    /** The server's events, live, each with the JSON it came as. */
    val events: SharedFlow<LiveEvent> = _events

    private val _resyncs = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Each time the connection came (back) online or events were lost: whoever shows server state reloads it. */
    val resyncs: SharedFlow<Unit> = _resyncs

    @Volatile private var socket: RpcSocket? = null
    private var job: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)

    /** Starts connecting, unless already doing so or the connection cannot succeed until paired again. */
    fun start() {
        if (job?.isActive == true) return
        if (_state.value is ConnectionState.Revoked || _state.value is ConnectionState.CertificateMismatch) return
        job = scope.launch { run() }
    }

    /** Disconnects and stays offline until [start]. */
    fun stop() {
        job?.cancel()
        job = null
        socket?.close()
        socket = null
        if (_state.value !is ConnectionState.Revoked && _state.value !is ConnectionState.CertificateMismatch) {
            _state.value = ConnectionState.Offline
        }
    }

    /** Retries now instead of waiting out the backoff. */
    fun retryNow() {
        if (job?.isActive == true) wake.trySend(Unit) else start()
    }

    /** Calls [method] on the server; fails at once when not online. */
    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap())): JsonElement {
        val s = socket?.takeIf { _state.value is ConnectionState.Online } ?: throw NotConnectedException("${server.name} is not connected")
        return s.rpc.call(method, params)
    }

    suspend fun <T> call(method: String, params: JsonElement, result: KSerializer<T>): T =
        ProtocolJson.decodeFromJsonElement(result, call(method, params))

    /** Reloads the session list. */
    suspend fun refreshSessions() = reload(sessionList, "session.list", Session.serializer())

    /** Reloads the workspaces. */
    suspend fun refreshWorkspaces() {
        _workspaces.value = call("workspace.list", JsonObject(emptyMap()), ListSerializer(Workspace.serializer())).sortedBy { it.position }
    }

    /** Reloads what waits on the user. */
    suspend fun refreshPending() {
        _pending.value = call("session.pending", JsonObject(emptyMap()), Pending.serializer())
    }

    /** Makes a workspace named [name]. */
    suspend fun createWorkspace(name: String): Workspace {
        val made = call("workspace.create", buildJsonObject { put("name", JsonPrimitive(name.trim())) }, Workspace.serializer())
        _workspaces.update { list -> (list.filterNot { it.id == made.id } + made).sortedBy { it.position } }
        return made
    }

    /** Moves session [id], with its workers, into [workspace]. */
    suspend fun moveToWorkspace(id: String, workspace: String) {
        val moved = call("session.set_workspace", buildJsonObject {
            put("id", JsonPrimitive(id))
            put("workspace", JsonPrimitive(workspace))
        }, ListSerializer(Session.serializer()))
        moved.forEach(sessionList::upsert)
    }

    /** Reloads the features. */
    suspend fun refreshFeatures() = reload(featureList, "feature.list", Feature.serializer())

    private suspend fun <T : Any> reload(list: LiveList<T>, method: String, item: KSerializer<T>) {
        list.beginReload()
        var snapshot: List<T>? = null
        try {
            snapshot = call(method, JsonObject(emptyMap()), ListSerializer(item))
        } finally {
            list.endReload(snapshot)
        }
    }

    /** Answers a feature owner's [question] with an [option], [text], or both. */
    suspend fun answerFeatureQuestion(ownerId: String, question: String, option: String?, text: String) {
        val feature = call("feature.answer", buildJsonObject {
            put("id", JsonPrimitive(ownerId))
            put("question", JsonPrimitive(question))
            option?.let { put("option", JsonPrimitive(it)) }
            put("text", JsonPrimitive(text))
        }, Feature.serializer())
        featureList.upsert(feature)
    }

    private suspend fun run() {
        if (token == null) {
            _state.value = ConnectionState.Revoked("This device's key for ${server.name} is gone. Pair again.")
            return
        }
        var attempt = 0
        while (scope.isActive) {
            _state.value = ConnectionState.Connecting
            val outcome = try {
                session(token)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                e
            }
            outcome.fingerprintMismatch()?.let {
                _state.value = ConnectionState.CertificateMismatch(it.expected, it.actual)
                return
            }
            if (outcome is AuthRejected) {
                _state.value = ConnectionState.Revoked(outcome.message ?: "The server no longer accepts this device.")
                return
            }
            attempt = if (outcome is WasOnline) 1 else attempt + 1
            val limited = (outcome as? RpcException)?.takeIf { it.code == RemoteErrors.RATE_LIMITED }
            val wait = limited?.retryAfterSecs?.let { it * 1_000 } ?: backoffMillis(attempt)
            _state.value = ConnectionState.Retrying(describe(outcome.cause ?: outcome), clock() + wait)
            withTimeoutOrNull(wait) { wake.receive() }
        }
    }

    /** One connection, from opening to closing; returns (never throws, except cancellation) why it ended. */
    private suspend fun session(token: String): Throwable {
        val s = RpcSocket.open(http, server.host, server.port, server.fingerprint)
        socket = s
        try {
            val auth = try {
                ProtocolJson.decodeFromJsonElement(
                    AuthResult.serializer(),
                    s.rpc.call("remote.auth", buildJsonObject {
                        put("deviceId", JsonPrimitive(server.deviceId))
                        put("token", JsonPrimitive(token))
                    }),
                )
            } catch (e: RpcException) {
                // Only a refused device means pairing again; anything else (a rate limit) is retried.
                return if (e.code == RemoteErrors.AUTH_FAILED) AuthRejected(e.message) else e
            }
            if (auth.serverId != server.serverId) {
                return AuthRejected("This is not the server this device paired with.")
            }
            // Everything this connection starts is its child, and ends with it (or with stop()).
            return coroutineScope {
                val online = this
                s.rpc.onOverflow = { resync(online) }
                launch {
                    s.rpc.notifications.collect { n ->
                        when (n.method) {
                            "event" -> (n.params as? JsonObject)?.let { raw ->
                                Event.parse(raw)?.let { onEvent(LiveEvent(it, raw), online) }
                            }
                            "lagged", "notifications.lagged" -> resync(online)
                        }
                    }
                }
                _state.value = ConnectionState.Online(auth.serverName, auth.version)
                resync(online)
                val closed = s.awaitClosed()
                coroutineContext.cancelChildren()
                WasOnline(closed)
            }
        } finally {
            s.close()
            if (socket === s) socket = null
        }
    }

    /** Events may have been lost: reload the lists, and tell those showing a session to reload it. */
    private fun resync(online: CoroutineScope) {
        _resyncs.tryEmit(Unit)
        online.launch { runCatching { refreshSessions() }.onFailure { if (it is CancellationException) throw it } }
        online.launch { runCatching { refreshFeatures() }.onFailure { if (it is CancellationException) throw it } }
        online.launch { runCatching { refreshWorkspaces() }.onFailure { if (it is CancellationException) throw it } }
        online.launch { runCatching { refreshPending() }.onFailure { if (it is CancellationException) throw it } }
    }

    private fun onEvent(live: LiveEvent, online: CoroutineScope) {
        when (val event = live.event) {
            is Event.SessionCreated -> sessionList.upsert(event.session)
            is Event.SessionUpdated -> sessionList.upsert(event.session)
            is Event.SessionRemoved -> {
                sessionList.remove(event.sessionId)
                featureList.remove(event.sessionId)
            }
            is Event.FeatureUpdated -> featureList.upsert(event.feature)
            is Event.WorkspacesChanged -> _workspaces.value = event.workspaces.sortedBy { it.position }
            is Event.ItemCompleted -> if (event.item.kind == "agent_message" && event.item.text.isNotBlank()) {
                _lastReplies.update { it + (event.sessionId to event.item.text) }
            }
            is Event.ApprovalRequested -> _pending.update { p ->
                p?.copy(approvals = p.approvals.filterNot { it.id == event.approval.id } + event.approval)
            }
            is Event.ApprovalResolved -> _pending.update { p -> p?.copy(approvals = p.approvals.filterNot { it.id == event.approvalId }) }
            is Event.InputRequested -> _pending.update { p ->
                p?.copy(inputs = p.inputs.filterNot { it.id == event.request.id } + event.request)
            }
            is Event.InputResolved -> _pending.update { p -> p?.copy(inputs = p.inputs.filterNot { it.id == event.requestId }) }
            else -> {}
        }
        if (!_events.tryEmit(live)) resync(online)
    }

    private class AuthRejected(message: String?) : Exception(message)

    /** The connection was up and then dropped, for [cause]. */
    private class WasOnline(cause: Throwable?) : Exception(cause?.message ?: "Connection closed", cause)

    private fun describe(e: Throwable): String = when (e) {
        is java.net.UnknownHostException -> "Cannot find ${server.host}"
        is java.net.ConnectException -> "Cannot reach ${server.address}"
        is java.net.SocketTimeoutException -> "${server.address} does not answer"
        is javax.net.ssl.SSLException -> "Secure connection failed: ${e.message}"
        else -> e.message ?: e.javaClass.simpleName
    }
}

