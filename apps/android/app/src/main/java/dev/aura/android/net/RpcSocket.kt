package dev.aura.android.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.selects.select
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * One WebSocket to an Aura server, with JSON-RPC over it. The TLS
 * certificate must be [fingerprint]; nothing else is trusted.
 */
class RpcSocket private constructor(
    private val socket: WebSocket,
    val rpc: JsonRpcClient,
    private val closed: CompletableDeferred<Throwable?>,
) {
    /** Suspends until the socket closes; the error that closed it, or null for a clean close. */
    suspend fun awaitClosed(): Throwable? = closed.await()

    fun close() {
        socket.close(1000, null)
        socket.cancel()
        closed.complete(null)
        rpc.close()
    }

    companion object {
        /** Opens a socket to `wss://host:port/`, or throws why it could not. */
        suspend fun open(base: OkHttpClient, host: String, port: Int, fingerprint: String): RpcSocket {
            val client = base.newBuilder()
                .pinnedTo(fingerprint)
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
            val url = HttpUrl.Builder().scheme("https").host(host).port(port).build()
            val opened = CompletableDeferred<Unit>()
            val closed = CompletableDeferred<Throwable?>()
            lateinit var rpc: JsonRpcClient
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened.complete(Unit)
                }

                override fun onMessage(webSocket: WebSocket, text: String) = rpc.onMessage(text)

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    end(ConnectionClosedException(code, reason))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                    end(ConnectionClosedException(code, reason))

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    end(response?.let { HandshakeRejectedException(it.code, t) } ?: t)

                private fun end(cause: Throwable) {
                    closed.complete(cause)
                    opened.completeExceptionally(cause)
                    rpc.close(cause)
                }
            }
            val pending = arrayOfNulls<WebSocket>(1)
            rpc = JsonRpcClient(send = { frame -> pending[0]?.send(frame) ?: false })
            val socket = client.newWebSocket(Request.Builder().url(url).build(), listener)
            pending[0] = socket
            try {
                select<Unit> {
                    opened.onAwait { }
                    closed.onAwait { cause -> throw cause ?: ConnectionClosedException(1000, "") }
                }
            } catch (e: Throwable) {
                socket.cancel()
                throw e
            }
            return RpcSocket(socket, rpc, closed)
        }
    }
}

/** The server closed the WebSocket. */
class ConnectionClosedException(val code: Int, reason: String) :
    Exception(if (reason.isNotBlank()) "Connection closed: $reason" else "Connection closed ($code)")

/** The server answered the WebSocket upgrade with an HTTP error. */
class HandshakeRejectedException(val status: Int, cause: Throwable) :
    Exception("The server refused the connection (HTTP $status)", cause)
