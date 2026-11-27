package dev.aura.android.net

import dev.aura.android.pairing.PairingLink
import dev.aura.android.protocol.PairResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient

/** Pairs this device with the server [link] names, trusting only the certificate it names. */
suspend fun pair(http: OkHttpClient, link: PairingLink, deviceName: String): PairResult {
    val socket = RpcSocket.open(http, link.host, link.port, link.fingerprint)
    try {
        val result = socket.rpc.call("remote.pair", buildJsonObject {
            put("code", JsonPrimitive(link.code))
            put("deviceName", JsonPrimitive(deviceName))
        })
        return ProtocolJson.decodeFromJsonElement(PairResult.serializer(), result)
    } finally {
        socket.close()
    }
}
