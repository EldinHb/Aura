package dev.aura.android.widget

import dev.aura.android.data.SavedServer
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.ui.inbox.ServerSnapshot
import dev.aura.android.ui.inbox.inboxOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WaitingSnapshotTest {
    private val server = SavedServer("a", "Laptop", "h", 1, "a".repeat(64), "srv", "d", "")

    private fun waiting(id: String) = Session(id = id, provider = "claude", title = "Session $id", pendingCount = 1)

    @Test
    fun `the snapshot counts everything and lists questions first, then the first sessions`() {
        val snapshot = WaitingSnapshot.of(
            inboxOf(
                listOf(server),
                mapOf(
                    "a" to ServerSnapshot(
                        sessions = (1..4).map { waiting("s$it") },
                        features = listOf(Feature("owner", "Ship it", questions = listOf(UserQuestion(id = "q", question = "Which colour?")))),
                    ),
                ),
            ),
        )
        assertEquals(5, snapshot.count)
        assertEquals(WaitingSnapshot.SHOWN, snapshot.items.size)
        assertEquals(WaitingItem("a", "owner", "Which colour?", "Laptop · Ship it"), snapshot.items.first())
        assertEquals("s1", snapshot.items[1].sessionId)
        assertEquals("Session s1", snapshot.items[1].title)
    }

    @Test
    fun `the inbox is loaded only once every server's sessions are`() {
        val two = listOf(server, server.copy(id = "b"))
        val one = mapOf("a" to ServerSnapshot(emptyList(), emptyList()))
        assertFalse(inboxOf(two, one).loaded)
        assertFalse(inboxOf(two, one + ("b" to ServerSnapshot(emptyList(), emptyList(), loaded = false))).loaded)
        assertTrue(inboxOf(two, one + ("b" to ServerSnapshot(emptyList(), emptyList()))).loaded)
        assertTrue(inboxOf(emptyList(), emptyMap()).loaded)
    }
}
