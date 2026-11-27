package dev.aura.android.net

import dev.aura.android.data.SavedServer
import dev.aura.android.protocol.AuthResult
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import kotlin.coroutines.cancellation.CancellationException

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

    private val _sessions = MutableStateFlow<List<Session>?>(null)

    /** The server's sessions; null until first loaded. */
    val sessions: StateFlow<List<Session>?> = _sessions

    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 4096)

    /** The server's events, live. */
    val events: SharedFlow<Event> = _events

    private val _resyncs = MutableSharedFlow<Unit>(extraBufferCapacity = 8)

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
    suspend fun refreshSessions() {
        _sessions.value = call("session.list", JsonObject(emptyMap()), ListSerializer(Session.serializer()))
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
            val wait = backoffMillis(attempt)
            _state.value = ConnectionState.Retrying(describe(outcome.cause ?: outcome), clock() + wait)
            select {
                wake.onReceive { }
                onTimeout(wait) { }
            }
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
                return AuthRejected(e.message)
            }
            if (auth.serverId != server.serverId) {
                return AuthRejected("This is not the server this device paired with.")
            }
            val listener = scope.launch {
                s.rpc.notifications.collect { n ->
                    when (n.method) {
                        "event" -> (n.params as? JsonObject)?.let(Event::parse)?.let(::onEvent)
                        "lagged", "notifications.lagged" -> resync()
                    }
                }
            }
            _state.value = ConnectionState.Online(auth.serverName, auth.version)
            resync()
            val closed = s.awaitClosed()
            listener.cancel()
            return WasOnline(closed)
        } finally {
            s.close()
            if (socket === s) socket = null
        }
    }

    private fun resync() {
        _resyncs.tryEmit(Unit)
        scope.launch { runCatching { refreshSessions() } }
    }

    private fun onEvent(event: Event) {
        when (event) {
            is Event.SessionCreated -> upsert(event.session)
            is Event.SessionUpdated -> upsert(event.session)
            is Event.SessionRemoved -> _sessions.value = _sessions.value?.filterNot { it.id == event.sessionId }
            else -> {}
        }
        _events.tryEmit(event)
    }

    private fun upsert(session: Session) {
        val list = _sessions.value ?: return
        val i = list.indexOfFirst { it.id == session.id }
        _sessions.value = if (i >= 0) list.toMutableList().also { it[i] = session } else list + session
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

