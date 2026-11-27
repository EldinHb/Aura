package dev.aura.android.transcript

import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.StoredEvent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class HistoryTest {
    private fun json(s: String) = ProtocolJson.parseToJsonElement(s).jsonObject

    private fun item(id: String, status: String, text: String = "") =
        """{"id":"$id","session_id":"s","kind":"agent_message","status":"$status","text":"$text","data":{}}"""

    private fun started(id: String) = json("""{"type":"item_started","session_id":"s","item":${item(id, "in_progress")}}""")
    private fun completed(id: String, text: String) = json("""{"type":"item_completed","session_id":"s","item":${item(id, "completed", text)}}""")
    private fun delta(id: String, text: String) = json("""{"type":"item_delta","session_id":"s","item_id":"$id","delta":{"kind":"text","text":"$text"}}""")

    private fun stored(vararg events: JsonObject) = events.mapIndexed { i, e -> StoredEvent(i + 1L, e) }

    @Test
    fun `history is read a page at a time until a short page`() = runTest {
        val all = (1L..12L).map { StoredEvent(it, JsonObject(emptyMap())) }
        val asked = mutableListOf<Long>()
        val got = fetchHistory(limit = 5) { after, limit ->
            asked += after
            all.filter { it.seq > after }.take(limit)
        }
        assertEquals(all, got)
        assertEquals(listOf(0L, 5L, 10L), asked)
    }

    @Test
    fun `an exact multiple of the page ends on an empty page`() = runTest {
        val all = (1L..10L).map { StoredEvent(it, JsonObject(emptyMap())) }
        assertEquals(10, fetchHistory(limit = 5) { after, limit -> all.filter { it.seq > after }.take(limit) }.size)
    }

    @Test
    fun `live events already in the history are not applied twice`() {
        // The item finished before the history was read, and its events also came live meanwhile.
        val history = stored(started("a"), completed("a", "Hello"))
        val live = listOf(started("a"), delta("a", "Hel"), delta("a", "lo"), completed("a", "Hello"))
        val t = reconcile(history, Pending(), "s", live)
        assertEquals("Hello", t.items.getValue("a").text)
        assertEquals("completed", t.items.getValue("a").status)
    }

    @Test
    fun `deltas after the snapshot are kept`() {
        // The history ends with the item started; the text streamed after it came live.
        val history = stored(started("a"))
        val live = listOf(started("a"), delta("a", "Hel"), delta("a", "lo"))
        val t = reconcile(history, Pending(), "s", live)
        assertEquals("Hello", t.items.getValue("a").text)
        assertEquals("in_progress", t.items.getValue("a").status)
    }

    @Test
    fun `live events after the history are applied in order`() {
        val history = stored(started("a"), completed("a", "One"))
        val live = listOf(completed("a", "One"), started("b"), delta("b", "Tw"), delta("b", "o"), completed("b", "Two!"))
        val t = reconcile(history, Pending(), "s", live)
        assertEquals(listOf("a", "b"), t.order)
        assertEquals("Two!", t.items.getValue("b").text)
    }

    @Test
    fun `waiting approvals come from pending, then live resolutions apply`() {
        val approval = """{"id":"p","session_id":"s","kind":"command","title":"Run","payload":{},"options":["accept"]}"""
        val other = """{"id":"x","session_id":"other","kind":"command","title":"Other","payload":{},"options":["accept"]}"""
        val pending = ProtocolJson.decodeFromString(Pending.serializer(), """{"approvals":[$approval,$other],"inputs":[]}""")
        assertEquals(listOf("p"), reconcile(emptyList(), pending, "s", emptyList()).approvals.map { it.id })
        val resolved = json("""{"type":"approval_resolved","session_id":"s","approval_id":"p","decision":{"option":"accept"}}""")
        assertEquals(emptyList<String>(), reconcile(emptyList(), pending, "s", listOf(resolved)).approvals.map { it.id })
    }
}
