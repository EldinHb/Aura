package dev.aura.android.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** A JSON-RPC error the server answered with. */
class RpcException(val code: Int, message: String, val data: JsonElement? = null) : Exception(message) {
    /** For [RemoteErrors.RATE_LIMITED]: how long the server wants the client to wait, in seconds. */
    val retryAfterSecs: Long?
        get() = ((data as? JsonObject)?.get("retryAfterSecs") as? JsonPrimitive)?.longOrNull
}

/** The remote listener's error codes (docs/design/remote.md, section 5). */
object RemoteErrors {
    /** A method other than pairing or auth before authenticating. The server closes the connection. */
    const val NOT_AUTHENTICATED = -32010

    /** Unknown or revoked device, or wrong token. The server closes the connection. */
    const val AUTH_FAILED = -32011

    /** The pairing code is wrong, expired or used. The server closes the connection. */
    const val PAIR_CODE_INVALID = -32012

    /** Too many failed attempts from this address; see [RpcException.retryAfterSecs]. */
    const val RATE_LIMITED = -32013

    /** The method or a parameter is not allowed for remote clients. */
    const val FORBIDDEN = -32003
}

/** The connection closed, or was never open, before the answer came. */
class NotConnectedException(message: String = "Not connected") : Exception(message)

/** A notification from the server: a message with a method and no id. */
data class RpcNotification(val method: String, val params: JsonElement)

/**
 * JSON-RPC 2.0 over any text transport. [send] puts one frame on the wire
 * and says whether it could; whoever reads the wire hands each text frame to
 * [onMessage], and calls [close] when the transport goes away.
 */
class JsonRpcClient(
    private val send: (String) -> Boolean,
    private val json: Json = ProtocolJson,
) {
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    @Volatile private var closed: Throwable? = null

    private val _notifications = MutableSharedFlow<RpcNotification>(extraBufferCapacity = 4096)

    /** Notifications, as they arrive. Ones that come while nobody collects are dropped. */
    val notifications: SharedFlow<RpcNotification> = _notifications

    /**
     * Called when a notification was dropped because its collector fell too
     * far behind: whoever shows server state should reload it, as on `lagged`.
     */
    @Volatile var onOverflow: () -> Unit = {}

    /** Calls [method] and waits up to [timeoutMs] for its result. */
    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap()), timeoutMs: Long = DEFAULT_TIMEOUT_MS): JsonElement {
        closed?.let { throw NotConnectedException(it.message ?: "Not connected") }
        val id = nextId.getAndIncrement()
        val answer = CompletableDeferred<JsonElement>()
        pending[id] = answer
        try {
            val frame = buildJsonObject {
                put("jsonrpc", JsonPrimitive("2.0"))
                put("id", JsonPrimitive(id))
                put("method", JsonPrimitive(method))
                put("params", params)
            }
            if (!send(json.encodeToString(JsonObject.serializer(), frame))) {
                throw NotConnectedException()
            }
            return withTimeout(timeoutMs) { answer.await() }
        } finally {
            pending.remove(id)
        }
    }

    /**
     * Takes one text frame from the server. Frames that are not JSON-RPC are
     * ignored; an answer with a malformed error still fails its call.
     */
    fun onMessage(text: String) {
        val msg = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return
        val id = (msg["id"] as? JsonPrimitive)?.longOrNull
        val method = (msg["method"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        when {
            method != null && id == null -> {
                if (!_notifications.tryEmit(RpcNotification(method, msg["params"] ?: JsonNull))) onOverflow()
            }
            id != null -> {
                val answer = pending[id] ?: return
                val error = msg["error"]?.takeUnless { it is JsonNull }
                when {
                    error == null -> answer.complete(msg["result"] ?: JsonNull)
                    error is JsonObject -> answer.completeExceptionally(
                        RpcException(
                            code = (error["code"] as? JsonPrimitive)?.intOrNull ?: 0,
                            message = (error["message"] as? JsonPrimitive)?.contentOrNull ?: "Error",
                            data = error["data"],
                        ),
                    )
                    else -> answer.completeExceptionally(RpcException(0, "Malformed error from the server: $error"))
                }
            }
        }
    }

    /** The transport is gone: every call waiting fails with [cause], and later calls fail at once. */
    fun close(cause: Throwable = NotConnectedException()) {
        closed = cause
        val waiting = pending.values.toList()
        pending.clear()
        waiting.forEach { it.completeExceptionally(NotConnectedException(cause.message ?: "Disconnected")) }
    }

    companion object {
        const val DEFAULT_TIMEOUT_MS = 30_000L
    }
}

/** How the protocol's JSON is read and written: unknown fields are fine, nulls may be left out. */
val ProtocolJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}

/** The code of this error when the server answered with an error. */
val Throwable.rpcCode: Int? get() = (this as? RpcException)?.code

