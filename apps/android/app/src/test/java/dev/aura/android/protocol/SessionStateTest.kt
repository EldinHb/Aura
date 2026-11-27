package dev.aura.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionStateTest {
    private fun session(id: String, status: String = "idle", attention: String? = null, pending: Int = 0, cwd: String = "/p/a", activity: String = "2026-01-01") =
        Session(id = id, provider = "claude", cwd = cwd, status = status, attention = attention, pendingCount = pending, lastActivity = activity)

    @Test
    fun `states are read from status, attention and pending work`() {
        assertEquals(SessionState.Waiting, session("a", pending = 1).state)
        assertEquals(SessionState.Waiting, session("a", status = "waiting_approval").state)
        assertEquals(SessionState.Waiting, session("a", attention = "waiting").state)
        assertEquals(SessionState.Running, session("a", status = "running").state)
        assertEquals(SessionState.Failed, session("a", status = "error").state)
        assertEquals(SessionState.Failed, session("a", attention = "failed").state)
        assertEquals(SessionState.Done, session("a", attention = "done").state)
        assertEquals(SessionState.Idle, session("a").state)
    }

    @Test
    fun `waiting sessions come first, then running ones, then the latest`() {
        val list = listOf(
            session("old", activity = "2026-01-01"),
            session("new", activity = "2026-03-01"),
            session("run", status = "running", activity = "2025-01-01"),
            session("wait", pending = 2, activity = "2024-01-01"),
        )
        assertEquals(listOf("wait", "run", "new", "old"), list.ordered().map { it.id })
    }

    @Test
    fun `sessions are grouped by project, a worktree counting as its repository`() {
        val wt = session("w", cwd = "/wt/feature").copy(worktree = WorktreeInfo("/p/a", "/wt/feature", "feature"))
        val groups = groupByProject(listOf(session("a"), wt, session("b", cwd = "/p/b/"), session("gone").copy(archived = true)))
        assertEquals(listOf("/p/a", "/p/b/"), groups.map { it.path })
        assertEquals(listOf("a", "b"), groups.map { it.name })
        assertEquals(setOf("a", "w"), groups[0].sessions.map { it.id }.toSet())
    }

    @Test
    fun `folder names handle both separators`() {
        assertEquals("repo", folderName("C:\\src\\repo"))
        assertEquals("repo", folderName("/home/me/repo/"))
        assertEquals("/", folderName("/"))
    }
}
