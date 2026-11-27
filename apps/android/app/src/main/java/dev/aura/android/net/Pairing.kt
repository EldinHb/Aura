package dev.aura.android.net

import dev.aura.android.pairing.PairingLink
import dev.aura.android.protocol.PairResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import java.io.IOException
import javax.net.ssl.SSLException

/** A successful pairing, and the address of [link] that answered. */
data class Paired(val result: PairResult, val host: String)

/**
 * Pairs this device with the server [link] names, trusting only the
 * certificate it names. Tries the link's addresses in order, moving on only
 * while none can be connected to: once one answers (or shows another
 * certificate) that is the outcome, so the one-time code is sent at most once.
 */
suspend fun pair(http: OkHttpClient, link: PairingLink, deviceName: String): Paired {
    var unreachable: Throwable? = null
    for (host in link.hosts) {
        val socket = try {
            RpcSocket.open(http, host, link.port, link.fingerprint)
        } catch (e: IOException) {
            if (e is SSLException || e.fingerprintMismatch() != null) throw e
            unreachable = unreachable ?: e
            continue
        }
        try {
            val result = socket.rpc.call("remote.pair", buildJsonObject {
                put("code", JsonPrimitive(link.code))
                put("deviceName", JsonPrimitive(deviceName))
            })
            return Paired(ProtocolJson.decodeFromJsonElement(PairResult.serializer(), result), host)
        } finally {
            socket.close()
        }
    }
    throw unreachable ?: IOException("No address to reach")
}
