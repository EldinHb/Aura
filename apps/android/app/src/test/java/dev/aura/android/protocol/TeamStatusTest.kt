package dev.aura.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class TeamStatusTest {
    private fun s(id: String, status: String = "idle", attention: String? = null, pending: Int = 0) =
        Session(id = id, provider = "claude", status = status, attention = attention, pendingCount = pending)

    @Test
    fun `each worker has one status, waiting on the user first`() {
        assertEquals(TeamStatus.WaitingOnYou, s("a", status = "running", pending = 1).teamStatus)
        assertEquals(TeamStatus.WaitingOnYou, s("a", status = "waiting_input").teamStatus)
        assertEquals(TeamStatus.Working, s("a", status = "running").teamStatus)
        assertEquals(TeamStatus.Failed, s("a", status = "error").teamStatus)
        assertEquals(TeamStatus.Failed, s("a", attention = "failed").teamStatus)
        assertEquals(TeamStatus.Done, s("a", attention = "done").teamStatus)
        assertEquals(TeamStatus.Done, s("a", status = "exited").teamStatus)
        assertEquals(TeamStatus.Idle, s("a").teamStatus)
    }

    @Test
    fun `the team is summed up working first, empty states left out`() {
        val team = listOf(s("1", "running"), s("2", "running"), s("3", "running"), s("4", pending = 1), s("5"), s("6"))
        assertEquals(listOf(TeamStatus.Working to 3, TeamStatus.WaitingOnYou to 1, TeamStatus.Idle to 2), teamCounts(team))
        assertEquals(emptyList<Pair<TeamStatus, Int>>(), teamCounts(emptyList()))
    }
}
