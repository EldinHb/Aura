package dev.aura.android.ui

import dev.aura.android.data.SavedServer
import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.ui.inbox.ServerSnapshot
import dev.aura.android.ui.inbox.inboxOf
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InboxTest {
    private fun server(id: String) = SavedServer(id, "Server $id", "h", 1, "a".repeat(64), "srv-$id", "d", "")

    private fun question(id: String, answered: Boolean = false, withdrawn: Boolean = false, at: String = "2026-01-01") = UserQuestion(
        id = id,
        question = "Q$id",
        askedAt = at,
        answer = if (answered) buildJsonObject { put("text", JsonPrimitive("ok")) } else null,
        withdrawn = withdrawn,
    )

    @Test
    fun `a question is open until answered or withdrawn`() {
        assertTrue(question("1").open)
        assertFalse(question("1", answered = true).open)
        assertFalse(question("1", withdrawn = true).open)
        val fromWire = ProtocolJson.decodeFromString(UserQuestion.serializer(), """{"id":"q","question":"?","answer":null,"withdrawn":false}""")
        assertTrue(fromWire.open)
    }

    @Test
    fun `the inbox gathers open questions and waiting sessions from every server`() {
        val a = server("a")
        val b = server("b")
        val snapshots = mapOf(
            "a" to ServerSnapshot(
                sessions = listOf(
                    Session(id = "w", provider = "claude", pendingCount = 1),
                    Session(id = "idle", provider = "claude"),
                    Session(id = "gone", provider = "claude", pendingCount = 1, archived = true),
                ),
                features = listOf(Feature("o1", "Goal", questions = listOf(question("1", at = "2026-01-01"), question("2", answered = true)))),
            ),
            "b" to ServerSnapshot(
                sessions = emptyList(),
                features = listOf(Feature("o2", "Other", questions = listOf(question("3", at = "2026-02-01")))),
            ),
        )
        val inbox = inboxOf(listOf(a, b), snapshots)
        assertEquals(listOf("3", "1"), inbox.questions.map { it.question.id })
        assertEquals("Server b", inbox.questions.first().serverName)
        assertEquals(listOf("w"), inbox.sessions.map { it.session.id })
        assertEquals(3, inbox.size)
    }

    @Test
    fun `a feature update event is read`() {
        val event = Event.parse(
            ProtocolJson.parseToJsonElement(
                """{"type":"feature_updated","session_id":"o1","feature":{"owner_id":"o1","goal":"G","status":"waiting_on_user","questions":[{"id":"q1","question":"Why?","options":[{"label":"A","description":null}],"kind":"irreversible","answer":null,"withdrawn":false}]}}""",
            ).jsonObject,
        ) as Event.FeatureUpdated
        assertEquals("irreversible", event.feature.questions.single().kind)
        assertEquals("A", event.feature.questions.single().options.single().label)
    }
}
