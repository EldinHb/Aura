package dev.aura.android.net

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A stand-in for aurad's remote listener: TLS with a self-signed certificate
 * that names no host, and JSON-RPC over a WebSocket that answers with
 * [handle] (a result, or an error object under the key `error`).
 */
class FakeAurad(
    private val handle: (method: String, params: JsonObject) -> JsonElement,
) : Closeable {
    val certificate: HeldCertificate = HeldCertificate.Builder().commonName("aurad").build()
    val fingerprint: String = Fingerprint.of(certificate.certificate)
    val requests = CopyOnWriteArrayList<String>()
    val sockets = CopyOnWriteArrayList<WebSocket>()
    private val server = MockWebServer()

    init {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        server.start()
    }

    val host: String get() = server.hostName
    val port: Int get() = server.port

    /** Lets [count] more connections in. */
    fun accept(count: Int = 1) = repeat(count) {
        server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())
    }

    /** Sends a notification on every open socket. */
    fun notify(method: String, params: JsonElement) {
        val frame = buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("method", JsonPrimitive(method))
            put("params", params)
        }.toString()
        sockets.forEach { it.send(frame) }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets += webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val request = ProtocolJson.parseToJsonElement(text).jsonObject
            val method = request["method"]!!.jsonPrimitive.content
            requests += method
            val answer = handle(method, request["params"] as? JsonObject ?: JsonObject(emptyMap()))
            val error = (answer as? JsonObject)?.get("error")
            webSocket.send(
                buildJsonObject {
                    put("jsonrpc", JsonPrimitive("2.0"))
                    put("id", request["id"]!!)
                    if (error != null) put("error", error) else put("result", answer)
                }.toString(),
            )
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    override fun close() {
        sockets.forEach { it.close(1001, null) }
        server.close()
    }

    companion object {
        fun error(code: Int, message: String) = buildJsonObject {
            put("error", buildJsonObject {
                put("code", JsonPrimitive(code))
                put("message", JsonPrimitive(message))
            })
        }
    }
}
