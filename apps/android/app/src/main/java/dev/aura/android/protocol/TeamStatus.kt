package dev.aura.android.protocol

/** How a worker or team member is doing, as its leader's team shows it. */
enum class TeamStatus { WaitingOnYou, Working, Failed, Done, Idle }

val Session.teamStatus: TeamStatus
    get() = when {
        waitsOnUser -> TeamStatus.WaitingOnYou
        status == "running" -> TeamStatus.Working
        attention == "failed" || status == "error" -> TeamStatus.Failed
        attention == "done" || status == "exited" -> TeamStatus.Done
        else -> TeamStatus.Idle
    }

/** How many of [workers] are in each state, in the order they are worth reading. */
fun teamCounts(workers: List<Session>): List<Pair<TeamStatus, Int>> =
    workers.groupingBy { it.teamStatus }.eachCount().let { counts ->
        listOf(TeamStatus.Working, TeamStatus.WaitingOnYou, TeamStatus.Failed, TeamStatus.Idle, TeamStatus.Done)
            .mapNotNull { s -> counts[s]?.let { s to it } }
    }
