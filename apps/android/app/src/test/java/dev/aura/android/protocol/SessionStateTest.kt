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
    fun `folder names handle both separators`() {
        assertEquals("repo", folderName("C:\\src\\repo"))
        assertEquals("repo", folderName("/home/me/repo/"))
        assertEquals("/", folderName("/"))
    }
}
