package dev.aura.android.notify

import dev.aura.android.net.Prompts
import dev.aura.android.protocol.Approval
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Question
import dev.aura.android.protocol.QuestionAnswer
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.UserInputRequest
import dev.aura.android.protocol.UserQuestion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NoticesTest {
    private fun s(id: String, parent: String? = null, attention: String? = null, activity: String = "t1") =
        Session(id = id, provider = "claude", title = "Title $id", orchestratorId = parent, attention = attention, lastActivity = activity)

    private fun view(
        sessions: List<Session> = emptyList(),
        features: List<Feature> = emptyList(),
        pending: Pending = Pending(),
        replies: Map<String, String> = emptyMap(),
        // Each session's latest message from the user, started the turn named after its last activity.
        prompts: Map<String, Prompts> = sessions.associate { it.id to Prompts(latestFromUser = true, userTurn = it.lastActivity) },
    ) = ServerView("srv", sessions, features, pending, replies, prompts)

    private fun question(id: String, answered: Boolean = false) =
        UserQuestion(id = id, question = "Ship it?", answer = if (answered) QuestionAnswer("Yes") else null)

    @Test
    fun `an open decision is a notice, an answered one is not`() {
        val notices = activeNotices(view(listOf(s("owner")), listOf(Feature("owner", "Goal", questions = listOf(question("q1"), question("q2", answered = true))))))
        assertEquals(listOf("decision:owner:q1"), notices.map { it.key })
        assertEquals(NoticeKind.Decision, notices.single().kind)
        assertEquals("Title owner", notices.single().title)
    }

    @Test
    fun `only a main chat's finished turn is a message, with the latest reply`() {
        val notices = activeNotices(
            view(
                sessions = listOf(
                    s("main", attention = "done", activity = "t2"),
                    s("worker", parent = "main", attention = "done"),
                    s("quiet"),
                    s("broken", attention = "failed"),
                ),
                replies = mapOf("main" to "All green."),
            ),
        )
        assertEquals(listOf("message:main:t2", "message:broken:t1"), notices.map { it.key })
        assertEquals("All green.", notices[0].text)
        assertTrue(notices[1].failed)
    }

    @Test
    fun `approvals and questions of any session are notices, opening that session`() {
        val pending = Pending(
            approvals = listOf(Approval(id = "a1", sessionId = "worker", title = "Run tests")),
            inputs = listOf(UserInputRequest(id = "i1", sessionId = "main", questions = listOf(Question(id = "q", question = "Which?")))),
        )
        val notices = activeNotices(view(listOf(s("main"), s("worker", parent = "main")), pending = pending))
        assertEquals(listOf("approval:a1", "question:i1"), notices.map { it.key })
        assertEquals("worker", notices[0].sessionId)
        assertEquals("a1", notices[0].approvalId)
        assertEquals("Which?", notices[1].text)
    }

    @Test
    fun `the first sight of a server notifies nothing and remembers everything`() {
        val active = activeNotices(view(listOf(s("main", attention = "done"))))
        val first = noticeUpdate(active, seen = emptySet(), posted = emptySet(), baseline = true, openSessionId = null)
        assertTrue(first.post.isEmpty())
        assertEquals(setOf("message:main:t1"), first.seen)
    }

    @Test
    fun `new notices are posted once, also across a reload`() {
        val before = activeNotices(view(listOf(s("main"))))
        val after = activeNotices(view(listOf(s("main", attention = "done", activity = "t2"))))
        val first = noticeUpdate(before, emptySet(), emptySet(), baseline = true, openSessionId = null)
        val second = noticeUpdate(after, first.seen, emptySet(), baseline = false, openSessionId = null)
        assertEquals(listOf("message:main:t2"), second.post.map { it.key })
        // The same state again, as after a resync: nothing new.
        val third = noticeUpdate(after, second.seen, setOf("message:main:t2"), baseline = false, openSessionId = null)
        assertTrue(third.post.isEmpty())
        // The next turn is new again.
        val next = activeNotices(view(listOf(s("main", attention = "done", activity = "t3"))))
        assertEquals(listOf("message:main:t3"), noticeUpdate(next, third.seen, emptySet(), false, null).post.map { it.key })
    }

    @Test
    fun `what is on screen is not notified, and what stopped waiting is taken away`() {
        val active = activeNotices(view(listOf(s("main", attention = "done"), s("other", attention = "done"))))
        val update = noticeUpdate(active, emptySet(), posted = setOf("approval:gone"), baseline = false, openSessionId = "main")
        assertEquals(listOf("message:other:t1"), update.post.map { it.key })
        assertTrue("message:main:t1" in update.seen)
        assertEquals(setOf("approval:gone"), update.cancel)
    }
}
