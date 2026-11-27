package dev.aura.android.net

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonRpcClientTest {
    private val sent = mutableListOf<String>()
    private var open = true
    private val client = JsonRpcClient(send = { if (open) sent.add(it) else false })

    private fun lastRequest() = ProtocolJson.parseToJsonElement(sent.last()).jsonObject

    @Test
    fun `a call sends a JSON-RPC 2 request and returns the matching result`() = runTest {
        val answer = async(start = CoroutineStart.UNDISPATCHED) {
            client.call("session.get", buildJsonObject { put("id", JsonPrimitive("s1")) })
        }
        val request = lastRequest()
        assertEquals("2.0", request["jsonrpc"]!!.jsonPrimitive.content)
        assertEquals("session.get", request["method"]!!.jsonPrimitive.content)
        assertEquals("s1", request["params"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        val id = request["id"]!!.jsonPrimitive.long
        client.onMessage("""{"jsonrpc":"2.0","id":$id,"result":{"title":"x"}}""")
        assertEquals("x", answer.await().jsonObject["title"]!!.jsonPrimitive.content)
    }

    @Test
    fun `answers are matched by id whatever their order`() = runTest {
        val first = async(start = CoroutineStart.UNDISPATCHED) { client.call("a") }
        val firstId = lastRequest()["id"]!!.jsonPrimitive.long
        val second = async(start = CoroutineStart.UNDISPATCHED) { client.call("b") }
        val secondId = lastRequest()["id"]!!.jsonPrimitive.long
        assertTrue(firstId != secondId)
        client.onMessage("""{"id":$secondId,"result":2}""")
        client.onMessage("""{"id":$firstId,"result":1}""")
        assertEquals(1, first.await().jsonPrimitive.int)
        assertEquals(2, second.await().jsonPrimitive.int)
    }

    @Test
    fun `an error answer throws with its code, message and data`() = runTest {
        val answer = async(start = CoroutineStart.UNDISPATCHED) { runCatching { client.call("remote.auth") } }
        val id = lastRequest()["id"]!!.jsonPrimitive.long
        client.onMessage("""{"id":$id,"error":{"code":-32003,"message":"device revoked","data":{"why":"removed"}}}""")
        val e = answer.await().exceptionOrNull() as RpcException
        assertEquals(-32003, e.code)
        assertEquals("device revoked", e.message)
        assertEquals("removed", e.data!!.jsonObject["why"]!!.jsonPrimitive.content)
        assertEquals(-32003, e.rpcCode)
    }

    @Test
    fun `a null result is a result`() = runTest {
        val answer = async(start = CoroutineStart.UNDISPATCHED) { client.call("session.interrupt") }
        client.onMessage("""{"id":${lastRequest()["id"]},"result":null}""")
        answer.await()
    }

    @Test
    fun `notifications are published, not taken for answers`() = runTest {
        val got = async(start = CoroutineStart.UNDISPATCHED) { client.notifications.first() }
        client.onMessage("""{"jsonrpc":"2.0","method":"event","params":{"type":"session_removed","session_id":"s"}}""")
        val n = got.await()
        assertEquals("event", n.method)
        assertEquals("s", n.params.jsonObject["session_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `garbage and answers to nobody are ignored`() {
        client.onMessage("not json")
        client.onMessage("[1,2]")
        client.onMessage("""{"id":999,"result":1}""")
    }

    @Test
    fun `closing fails the calls waiting and every later call`() = runTest {
        val waiting = async(start = CoroutineStart.UNDISPATCHED) { runCatching { client.call("session.list") } }
        client.close(RuntimeException("socket gone"))
        assertTrue(waiting.await().exceptionOrNull() is NotConnectedException)
        val sentBefore = sent.size
        assertTrue(runCatching { client.call("session.list") }.exceptionOrNull() is NotConnectedException)
        assertEquals(sentBefore, sent.size)
    }

    @Test
    fun `a frame that cannot be sent fails the call at once`() = runTest {
        open = false
        assertTrue(runCatching { client.call("session.list") }.exceptionOrNull() is NotConnectedException)
    }

    @Test
    fun `a call times out when no answer comes`() = runTest {
        val result = runCatching { client.call("session.list", timeoutMs = 1_000) }
        assertTrue(result.exceptionOrNull() is TimeoutCancellationException)
        yield()
        client.onMessage("""{"id":1,"result":1}""")
        assertFalse(sent.isEmpty())
    }
}
