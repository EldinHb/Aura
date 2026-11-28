package dev.aura.android.protocol

import dev.aura.android.ui.session.sessionTree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionListTest {
    private fun s(
        id: String,
        parent: String? = null,
        status: String = "idle",
        attention: String? = null,
        pending: Int = 0,
        workspace: String = "w1",
        created: String = "2026-01-0${id.length}",
        activity: String = "2026-01-01",
        task: String? = null,
        run: String? = null,
        archived: Boolean = false,
        pinned: Boolean = false,
    ) = Session(
        id = id, provider = "claude", status = status, attention = attention, pendingCount = pending, orchestratorId = parent,
        workspace = workspace, createdAt = created, lastActivity = activity, scheduledTaskId = task, scheduledTaskName = task?.let { "Task $it" },
        scheduledRun = run, archived = archived, pinned = pinned,
    )

    @Test
    fun `categories match the desktop`() {
        assertEquals(Category.NeedsYou, s("a", pending = 1, status = "running").category)
        assertEquals(Category.NeedsYou, s("a", status = "waiting_input").category)
        assertEquals(Category.NeedsYou, s("a", attention = "done").category)
        assertEquals(Category.NeedsYou, s("a", attention = "failed", status = "error").category)
        assertEquals(Category.Working, s("a", status = "running").category)
        assertEquals(Category.Idle, s("a", status = "error").category)
        assertEquals(Category.Idle, s("a", status = "exited").category)
    }

    @Test
    fun `workers are no rows of their own and roll up into their leader`() {
        val sessions = listOf(
            s("lead"),
            s("w1", parent = "lead", status = "running"),
            s("w2", parent = "w1", pending = 1),
            s("solo", status = "running"),
        )
        val list = sessionList(sessions, emptyList())
        val sections = list.workspaces.single().sections
        assertEquals(listOf(Category.NeedsYou, Category.Working), sections.map { it.category })
        val lead = sections[0].rows.single()
        assertEquals("lead", lead.session.id)
        assertEquals(listOf("w1", "w2"), lead.workers.map { it.id })
        assertEquals(1, lead.workersWaiting)
        assertEquals(listOf("solo"), sections[1].rows.map { it.session.id })
    }

    @Test
    fun `a finished worker reports to its orchestrator, not to the user`() {
        val list = sessionList(listOf(s("lead"), s("w", parent = "lead", attention = "done")), emptyList())
        assertEquals(Category.Idle, list.workspaces.single().sections.single().category)
    }

    @Test
    fun `a worker whose orchestrator is gone leads, and a cycle is cut at its oldest`() {
        val forest = Forest(listOf(s("orphan", parent = "gone"), s("a", parent = "bb", created = "2026-01-01"), s("bb", parent = "a", created = "2026-01-02")))
        assertEquals("orphan", forest.leaderOf(s("orphan", parent = "gone")).id)
        assertEquals(null, forest.parentOf("a"))
        assertEquals("a", forest.parentOf("bb")?.id)
    }

    @Test
    fun `scheduled runs and their workers go to their own tab, a section per task, newest first`() {
        val sessions = listOf(
            s("run1", task = "t1", created = "2026-01-01"),
            s("run2", task = "t1", created = "2026-01-03"),
            s("w", parent = "run2", created = "2026-01-04"),
            s("orphan", run = "t1", created = "2026-01-05"),
            s("other", task = "t2", created = "2026-01-02"),
            s("plain"),
        )
        val list = sessionList(sessions, emptyList())
        assertEquals(listOf("plain"), list.workspaces.single().sections.flatMap { it.rows }.map { it.session.id })
        assertEquals(listOf("t1", "t2"), list.scheduled.map { it.taskId })
        assertEquals("Task t1", list.scheduled[0].name)
        assertEquals(listOf("orphan", "run2", "run1"), list.scheduled[0].runs.map { it.session.id })
        assertEquals(listOf("w"), list.scheduled[0].runs[1].workers.map { it.id })
    }

    @Test
    fun `leaders are grouped by workspace in the user's order, pinned first, archived left out`() {
        val workspaces = listOf(Workspace("w2", "Second", 1), Workspace("w1", "First", 0), Workspace("w3", "Empty", 2))
        val sessions = listOf(
            s("a", workspace = "w2", activity = "2026-03-01"),
            s("b", workspace = "w1", activity = "2026-01-01", pinned = true),
            s("c", workspace = "w1", activity = "2026-02-01"),
            s("d", workspace = "unknown"),
            s("e", workspace = "w1", archived = true),
        )
        val groups = sessionList(sessions, workspaces).workspaces
        assertEquals(listOf("First", "Second"), groups.map { it.workspace?.name })
        assertEquals(listOf("b", "c", "d"), groups[0].sections.single().rows.map { it.session.id })
    }

    @Test
    fun `a session opens with its leader's chat and the whole team as tabs`() {
        val sessions = listOf(s("lead"), s("w1", parent = "lead"), s("w2", parent = "w1"), s("gone", parent = "lead", archived = true), s("x"))
        assertEquals(listOf("lead", "w1", "w2"), sessionTree(sessions, "w2").map { it.id })
        assertEquals(listOf("lead", "w1", "w2", "gone"), sessionTree(sessions, "gone").map { it.id })
        assertEquals(listOf("x"), sessionTree(sessions, "x").map { it.id })
        assertTrue(sessionTree(sessions, "missing").isEmpty())
    }
}
