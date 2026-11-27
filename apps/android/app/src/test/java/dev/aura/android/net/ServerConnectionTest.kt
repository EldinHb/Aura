package dev.aura.android.net

import dev.aura.android.data.SavedServer
import dev.aura.android.pairing.PairingLink
import dev.aura.android.protocol.Event
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerConnectionTest {
    private val http = OkHttpClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val session = buildJsonObject {
        put("id", JsonPrimitive("s1"))
        put("provider", JsonPrimitive("claude"))
        put("title", JsonPrimitive("Fix the build"))
        put("status", JsonPrimitive("running"))
    }

    private val aurad = FakeAurad { method, params ->
        when (method) {
            "remote.pair" -> if (params["code"]?.jsonPrimitive?.content == "123456") {
                buildJsonObject {
                    put("deviceId", JsonPrimitive("d1"))
                    put("token", JsonPrimitive("good"))
                    put("serverId", JsonPrimitive("srv"))
                    put("serverName", JsonPrimitive("Studio"))
                    put("version", JsonPrimitive("0.6.0"))
                }
            } else {
                FakeAurad.error(RemoteErrors.PAIR_CODE_INVALID, "wrong or expired pairing code")
            }
            "remote.auth" -> if (params["token"]?.jsonPrimitive?.content == "limited") {
                buildJsonObject {
                    put("error", buildJsonObject {
                        put("code", JsonPrimitive(RemoteErrors.RATE_LIMITED))
                        put("message", JsonPrimitive("too many attempts"))
                        put("data", buildJsonObject { put("retryAfterSecs", JsonPrimitive(42)) })
                    })
                }
            } else if (params["token"]?.jsonPrimitive?.content == "good") {
                buildJsonObject {
                    put("serverId", JsonPrimitive("srv"))
                    put("serverName", JsonPrimitive("Studio"))
                    put("version", JsonPrimitive("0.6.0"))
                }
            } else {
                FakeAurad.error(RemoteErrors.AUTH_FAILED, "unknown device")
            }
            "session.list" -> JsonArray(listOf(session))
            else -> FakeAurad.error(-32601, "unknown method $method")
        }
    }

    @After
    fun tearDown() {
        scope.cancel()
        aurad.close()
    }

    private fun saved(fingerprint: String = aurad.fingerprint, serverId: String = "srv") = SavedServer(
        id = "local",
        name = "Studio",
        host = aurad.host,
        port = aurad.port,
        fingerprint = fingerprint,
        serverId = serverId,
        deviceId = "d1",
        sealedToken = "",
    )

    private fun link(code: String = "123456", fingerprint: String = aurad.fingerprint) =
        PairingLink(aurad.host, aurad.port, fingerprint, code, null)

    private suspend fun ServerConnection.reach(predicate: (ConnectionState) -> Boolean): ConnectionState =
        withTimeout(10_000) { state.first(predicate) }

    @Test
    fun `pairing trusts the pinned self-signed certificate and returns the device token`() = runBlocking {
        aurad.accept()
        val paired = pair(http, link(), "Pixel")
        assertEquals("good", paired.result.token)
        assertEquals("srv", paired.result.serverId)
        assertEquals(aurad.host, paired.host)
        assertEquals(listOf("remote.pair"), aurad.requests)
    }

    @Test
    fun `pairing falls back to the next address only when one cannot be reached`() = runBlocking {
        aurad.accept()
        val link = link().copy(host = "unreachable.invalid", alternates = listOf(aurad.host))
        val paired = pair(http, link, "Pixel")
        assertEquals(aurad.host, paired.host)
        assertEquals(listOf("remote.pair"), aurad.requests)
    }

    @Test
    fun `a server that answers ends the pairing, so the code is sent once`() = runBlocking {
        aurad.accept()
        val link = link(code = "000000").copy(alternates = listOf("unreachable.invalid"))
        val e = runCatching { pair(http, link, "Pixel") }.exceptionOrNull()
        assertTrue("$e", e is RpcException)
        assertEquals(listOf("remote.pair"), aurad.requests)
    }

    @Test
    fun `pairing with a wrong code reports the server's error`() = runBlocking {
        aurad.accept()
        val e = runCatching { pair(http, link(code = "000000"), "Pixel") }.exceptionOrNull()
        assertTrue("$e", e is RpcException && e.code == RemoteErrors.PAIR_CODE_INVALID)
    }

    @Test
    fun `pairing never talks to a server with another certificate`() = runBlocking {
        aurad.accept()
        val e = runCatching { pair(http, link(fingerprint = "0".repeat(64)), "Pixel") }.exceptionOrNull()
        assertEquals(aurad.fingerprint, e?.fingerprintMismatch()?.actual)
        assertTrue("nothing was sent", aurad.requests.isEmpty())
    }

    @Test
    fun `a connection authenticates, loads the sessions and follows events`() = runBlocking {
        aurad.accept()
        val c = ServerConnection(saved(), "good", http, scope)
        c.start()
        val online = c.reach { it is ConnectionState.Online } as ConnectionState.Online
        assertEquals("Studio", online.serverName)
        val sessions = withTimeout(10_000) { c.sessions.filterNotNull().first() }
        assertEquals("Fix the build", sessions.single().title)
        assertEquals("remote.auth", aurad.requests.first())

        // Subscribed before the server speaks.
        val event = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(10_000) { c.events.first() } }
        val updated = JsonObject(session + ("title" to JsonPrimitive("Renamed")))
        aurad.notify("event", buildJsonObject {
            put("type", JsonPrimitive("session_updated"))
            put("session", updated)
        })
        assertTrue(event.await() is Event.SessionUpdated)
        assertEquals("Renamed", c.sessions.value!!.single().title)
        c.stop()
        assertEquals(ConnectionState.Offline, c.state.value)
    }

    @Test
    fun `a rejected device token means the device must pair again`() = runBlocking {
        aurad.accept()
        val c = ServerConnection(saved(), "revoked", http, scope)
        c.start()
        val state = c.reach { it is ConnectionState.Revoked }
        assertTrue(state is ConnectionState.Revoked)
        c.retryNow()
        assertTrue("it does not retry by itself", c.state.value is ConnectionState.Revoked)
    }

    @Test
    fun `a rate limit is waited out as the server asks, not taken for a revoked device`() = runBlocking {
        aurad.accept()
        val now = 1_000_000L
        val c = ServerConnection(saved(), "limited", http, scope, clock = { now })
        c.start()
        val state = c.reach { it is ConnectionState.Retrying || it is ConnectionState.Revoked }
        assertEquals(now + 42_000, (state as ConnectionState.Retrying).retryAt)
    }

    @Test
    fun `a changed certificate is reported and never accepted`() = runBlocking {
        aurad.accept()
        val pinned = "0".repeat(64)
        val c = ServerConnection(saved(fingerprint = pinned), "good", http, scope)
        c.start()
        val state = c.reach { it is ConnectionState.CertificateMismatch } as ConnectionState.CertificateMismatch
        assertEquals(pinned, state.expected)
        assertEquals(aurad.fingerprint, state.actual)
        assertTrue(aurad.requests.isEmpty())
    }

    @Test
    fun `another server answering at the address is not taken for the paired one`() = runBlocking {
        aurad.accept()
        val c = ServerConnection(saved(serverId = "another"), "good", http, scope)
        c.start()
        assertTrue(c.reach { it is ConnectionState.Revoked } is ConnectionState.Revoked)
    }

    @Test
    fun `a lost token asks for pairing without connecting`() = runBlocking {
        val c = ServerConnection(saved(), null, http, scope)
        c.start()
        assertTrue(c.reach { it is ConnectionState.Revoked } is ConnectionState.Revoked)
    }

    @Test
    fun `a dropped connection is retried`() = runBlocking {
        aurad.accept(2)
        val c = ServerConnection(saved(), "good", http, scope)
        c.start()
        c.reach { it is ConnectionState.Online }
        aurad.sockets.first().close(1001, "restarting")
        c.reach { it is ConnectionState.Retrying }
        c.retryNow()
        c.reach { it is ConnectionState.Online }
        assertEquals(2, aurad.requests.count { it == "remote.auth" })
    }

    @Test
    fun `calls fail at once while offline`() = runBlocking {
        val c = ServerConnection(saved(), "good", http, scope)
        val e = runCatching { c.call("session.list") }.exceptionOrNull()
        assertTrue(e is NotConnectedException)
        Unit
    }

}
