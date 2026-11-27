package dev.aura.android.transcript

import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Event
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun event(json: String): Event = Event.parse(ProtocolJson.parseToJsonElement(json).jsonObject)!!

    private fun item(id: String, kind: String, text: String = "", status: String = "completed", extra: String = "") =
        """{"id":"$id","session_id":"s","kind":"$kind","status":"$status","text":"$text","data":{}$extra}"""

    @Test
    fun `streamed text is put together and the completed item replaces it`() {
        var t = Transcript()
        t = t.apply(event("""{"type":"turn_started","session_id":"s","turn":{"id":"t","session_id":"s","status":"running"}}"""))
        assertTrue(t.turnRunning)
        t = t.apply(event("""{"type":"item_started","session_id":"s","item":${item("a", "agent_message", status = "in_progress")}}"""))
        t = t.apply(event("""{"type":"item_delta","session_id":"s","item_id":"a","delta":{"kind":"text","text":"Hel"}}"""))
        t = t.apply(event("""{"type":"item_delta","session_id":"s","item_id":"a","delta":{"kind":"text","text":"lo"}}"""))
        assertEquals("Hello", t.items["a"]!!.text)
        t = t.apply(event("""{"type":"item_completed","session_id":"s","item":${item("a", "agent_message", "Hello!")}}"""))
        t = t.apply(event("""{"type":"turn_completed","session_id":"s","turn":{"id":"t","session_id":"s","status":"completed"}}"""))
        assertEquals(listOf("a"), t.order)
        assertEquals("Hello!", t.items["a"]!!.text)
        assertFalse(t.turnRunning)
    }

    @Test
    fun `command output and data deltas go into the item's data`() {
        var t = Transcript.of(listOf(event("""{"type":"item_started","session_id":"s","item":${item("c", "command_exec", status = "in_progress")}}""")))
        t = t.apply(event("""{"type":"item_delta","session_id":"s","item_id":"c","delta":{"kind":"output","text":"one\n"}}"""))
        t = t.apply(event("""{"type":"item_delta","session_id":"s","item_id":"c","delta":{"kind":"output","text":"two\n"}}"""))
        t = t.apply(event("""{"type":"item_delta","session_id":"s","item_id":"c","delta":{"kind":"data","data":{"exit_code":0}}}"""))
        val data = t.items["c"]!!.data
        assertEquals("one\ntwo\n", data["output"]!!.jsonPrimitive.content)
        assertEquals("0", data["exit_code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a late start keeps the text already streamed`() {
        var t = Transcript.of(listOf(event("""{"type":"item_completed","session_id":"s","item":${item("a", "agent_message", "done")}}""")))
        t = t.apply(event("""{"type":"item_started","session_id":"s","item":${item("a", "agent_message", status = "in_progress")}}"""))
        assertEquals("done", t.items["a"]!!.text)
        assertEquals(1, t.order.size)
    }

    @Test
    fun `approvals and questions wait until resolved`() {
        var t = Transcript()
        t = t.apply(event("""{"type":"approval_requested","session_id":"s","approval":{"id":"p","session_id":"s","kind":"command","title":"Run ls","payload":{"command":"ls"},"options":["accept","decline"],"created_at":"x"}}"""))
        t = t.apply(event("""{"type":"user_input_requested","session_id":"s","request":{"id":"q","session_id":"s","questions":[{"id":"1","question":"Which?","options":[{"label":"A"}],"multi_select":false,"allow_free_text":true,"secret":false}],"created_at":"x"}}"""))
        assertEquals("Run ls", t.approvals.single().title)
        assertEquals("Which?", t.inputs.single().questions.single().question)
        t = t.apply(event("""{"type":"approval_resolved","session_id":"s","approval_id":"p","decision":{"option":"accept"}}"""))
        t = t.apply(event("""{"type":"user_input_resolved","session_id":"s","request_id":"q","response":{"request_id":"q","answers":{},"declined":true}}"""))
        assertTrue(t.approvals.isEmpty())
        assertTrue(t.inputs.isEmpty())
    }

    @Test
    fun `a failed turn keeps its error until the next turn`() {
        var t = Transcript()
        t = t.apply(event("""{"type":"turn_completed","session_id":"s","turn":{"id":"t","session_id":"s","status":"failed","error":"rate limited"}}"""))
        assertEquals("rate limited", t.lastError)
        t = t.apply(event("""{"type":"turn_started","session_id":"s","turn":{"id":"u","session_id":"s","status":"running"}}"""))
        assertNull(t.lastError)
    }

    @Test
    fun `unknown and malformed events are skipped`() {
        assertNull(Event.parse(ProtocolJson.parseToJsonElement("""{"type":"usage","session_id":"s","usage":{}}""").jsonObject))
        assertNull(Event.parse(ProtocolJson.parseToJsonElement("""{"type":"item_started","session_id":"s"}""").jsonObject))
        assertNull(Event.parse(JsonObject(emptyMap())))
    }

    @Test
    fun `steps between messages fold into one row and subagent items hide under their parent`() {
        val items = listOf(
            item("u", "user_message", "go"),
            item("r", "reasoning", "hmm"),
            item("c", "command_exec", extra = ""","title":null"""),
            item("x", "tool_call", extra = ""","parent_id":"sub""""),
            item("a", "agent_message", "done"),
            item("e", "error", "boom"),
        ).map { ProtocolJson.decodeFromString(dev.aura.android.protocol.Item.serializer(), it) }
        val t = items.fold(Transcript()) { acc, it -> acc.apply(Event.ItemCompleted("s", it)) }
        val rows = rows(t.visibleItems)
        assertEquals(4, rows.size)
        assertTrue(rows[0] is Row.User)
        assertEquals(listOf("r", "c"), (rows[1] as Row.Work).items.map { it.id })
        assertTrue(rows[2] is Row.Agent)
        assertTrue(rows[3] is Row.Problem)
    }
}
