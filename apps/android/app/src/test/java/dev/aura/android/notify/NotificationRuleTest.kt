package dev.aura.android.notify

import dev.aura.android.data.NoticeSettings
import dev.aura.android.net.Prompts
import dev.aura.android.protocol.Item
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The "Message" rule, played through as the server's events would come: a main
 * chat's finished turn is notified once when the user started it, never when
 * Aura did (a worker report, an answer, a decision passed on).
 */
class NotificationRuleTest {
    /** A server as the app sees it, moved by events the way aurad moves it. */
    private class Server(sessions: List<Session>, var settings: NoticeSettings = NoticeSettings()) {
        val sessions = sessions.associateBy { it.id }.toMutableMap()
        val prompts = sessions.associate { it.id to Prompts() }.toMutableMap()
        var seen = emptySet<String>()
        val posted = mutableSetOf<String>()
        var notified = 0
        private var baselined = false
        private var turns = 0

        /** A message to [id]'s agent and the turn it starts and finishes. */
        fun turn(id: String, text: String, finish: Boolean = true) {
            val turn = "t" + ++turns
            prompts[id] = prompts.getValue(id).after(Item(id = "i$turns", sessionId = id, turnId = turn, kind = "user_message", text = text))
            // aurad: a turn the user (not Aura) starts makes what finished before old news.
            if (!text.startsWith(AURA)) update(id) { it.copy(attention = null, status = "running") }
            sync()
            if (finish) {
                update(id) { it.copy(attention = "done", status = "idle") }
                sync()
            }
        }

        fun update(id: String, change: (Session) -> Session) {
            sessions[id] = change(sessions.getValue(id))
        }

        /** What the Notifier does on each change. */
        fun sync() {
            val view = ServerView("srv", sessions.values.toList(), emptyList(), Pending(), emptyMap(), prompts.toMap())
            val result = noticeUpdate(activeNotices(view), seen, posted, baseline = !baselined, openSessionId = null)
            baselined = true
            seen = result.seen
            posted -= result.cancel
            result.post.filter(settings::wants).forEach { posted += it.key; notified++ }
        }
    }

    private fun main(id: String = "main") = Session(id = id, provider = "claude", title = id, orchestrator = true)

    @Test
    fun `an orchestrator taking in five worker reports notifies nothing`() {
        val server = Server(listOf(main()))
        server.sync()
        repeat(5) { server.turn("main", report(it)) }
        assertEquals(0, server.notified)
    }

    @Test
    fun `the user's message notifies once, and the reports after it neither again nor take it away`() {
        val server = Server(listOf(main()))
        server.sync()
        server.turn("main", "Ship the Android app")
        assertEquals(1, server.notified)
        repeat(5) { server.turn("main", report(it)) }
        assertEquals(1, server.notified)
        assertEquals(1, server.posted.size)
        // The status going back and forth, or a resync bringing the same state: nothing new.
        server.update("main") { it.copy(status = "running") }
        server.sync()
        server.update("main") { it.copy(status = "idle") }
        server.sync()
        assertEquals(1, server.notified)
    }

    @Test
    fun `what the user read on the desktop is not notified, nor brought back by a report`() {
        val server = Server(listOf(main()))
        server.sync()
        server.turn("main", "Ship it", finish = false)
        // It finishes and the desktop marks it seen before the phone hears it done.
        server.update("main") { it.copy(attention = null, status = "idle") }
        server.sync()
        server.turn("main", report(1))
        assertEquals(0, server.notified)
    }

    @Test
    fun `reading it on the desktop takes the notification away`() {
        val server = Server(listOf(main()))
        server.sync()
        server.turn("main", "Ship it")
        server.update("main") { it.copy(attention = null) }
        server.sync()
        assertTrue(server.posted.isEmpty())
    }

    @Test
    fun `workers, even of a gone orchestrator, are not main chats`() {
        val worker = Session(id = "w", provider = "claude", orchestratorId = "gone")
        val server = Server(listOf(main(), worker))
        server.sync()
        server.turn("w", "Fix the build")
        assertEquals(0, server.notified)
    }

    @Test
    fun `a scheduled task's run notifies only when the user asked for it`() {
        val run = Session(id = "nightly", provider = "claude", scheduledTaskId = "task")
        val off = Server(listOf(run))
        off.sync()
        off.turn("nightly", "Run the nightly checks")
        assertEquals(0, off.notified)
        val on = Server(listOf(run), NoticeSettings(scheduled = true))
        on.sync()
        on.turn("nightly", "Run the nightly checks")
        assertEquals(1, on.notified)
    }

    @Test
    fun `a main chat not known yet is looked up before it can notify`() {
        val view = ServerView("srv", listOf(main().copy(attention = "done")), emptyList(), Pending())
        assertTrue(activeNotices(view).isEmpty())
        assertEquals(listOf("main"), promptLookups(view, NoticeSettings()))
        assertTrue(promptLookups(view, NoticeSettings(messages = false)).isEmpty())
    }

    @Test
    fun `the prompts tell the user's messages from Aura's`() {
        val user = Item(id = "u", turnId = "t1", kind = "user_message", text = "Go")
        val aura = Item(id = "a", turnId = "t2", kind = "user_message", text = report(1))
        val subagent = Item(id = "s", turnId = "t3", kind = "user_message", text = "Go", parentId = "tool")
        assertEquals(Prompts(true, "t1"), Prompts().after(user))
        assertEquals(Prompts(false, "t1"), Prompts().after(user).after(aura))
        assertEquals(Prompts(true, "t1"), Prompts().after(user).after(subagent))
        assertFalse(Prompts().after(aura).latestFromUser)
    }

    @Test
    fun `the settings pick the categories`() {
        val message = Notice("m", NoticeKind.Message, "srv", "main", "t", "x")
        val approval = Notice("a", NoticeKind.Approval, "srv", "main", "t", "x", scheduled = true)
        assertTrue(NoticeSettings().wants(message))
        assertFalse(NoticeSettings(messages = false).wants(message))
        assertFalse(NoticeSettings().wants(message.copy(scheduled = true)))
        assertTrue(NoticeSettings().wants(approval))
        assertFalse(NoticeSettings(approvals = false).wants(approval))
        assertFalse(NoticeSettings(decisions = false).wants(message.copy(kind = NoticeKind.Decision)))
    }

    private companion object {
        const val AURA = "[Aura] "

        fun report(n: Int) = "[Aura] Report from worker $n. This message comes from Aura, not the user.\nDone."
    }
}
