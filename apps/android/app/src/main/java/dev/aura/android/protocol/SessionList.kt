package dev.aura.android.protocol

/** A leader's row: the session, and the workers under it (shown in the session, not as rows). */
data class LeaderRow(val session: Session, val workers: List<Session>, val rollup: Category) {
    /** Workers in the tree that wait on the user. */
    val workersWaiting: Int get() = workers.count { it.waitsOnUser }
}

/** One status section of a workspace. */
data class StatusSection(val category: Category, val rows: List<LeaderRow>)

/** A workspace's leaders, by status; [workspace] null against a daemon without workspaces. */
data class WorkspaceGroup(val workspace: Workspace?, val sections: List<StatusSection>) {
    val count: Int get() = sections.sumOf { it.rows.size }
    val needsYou: Int get() = sections.firstOrNull { it.category == Category.NeedsYou }?.rows?.size ?: 0
}

/** The runs of one scheduled task, newest first. */
data class TaskSection(val taskId: String, val name: String, val runs: List<LeaderRow>)

/** The session list as the desktop sidebar has it: the Sessions tab and the Scheduled tab. */
data class SessionList(val workspaces: List<WorkspaceGroup>, val scheduled: List<TaskSection>)

/**
 * Lays out [sessions] as the desktop sidebar does: only leaders get rows
 * (workers belong to their leader); scheduled runs go to their own tab, a
 * section per task with the task that ran last first; the rest are grouped by
 * workspace (in the user's order), then sectioned by the roll-up of each
 * leader's tree (needs you, working, idle), pinned first, then latest activity.
 * Archived leaders are left out.
 */
fun sessionList(sessions: List<Session>, workspaces: List<Workspace>): SessionList {
    val forest = Forest(sessions)
    val leaders = sessions.filter { !it.archived && forest.leaderOf(it).id == it.id }
    fun row(s: Session) = LeaderRow(s, forest.liveDescendantsOf(s.id), forest.rollupOf(s))
    val (scheduled, regular) = leaders.partition { forest.scheduledTaskOf(it) != null }

    val tasks = scheduled
        .sortedWith(compareByDescending<Session> { it.createdAt }.thenBy { it.id })
        .groupBy { forest.scheduledTaskOf(it)!! }
        .map { (task, runs) -> TaskSection(task, runs.firstNotNullOfOrNull { it.scheduledTaskName } ?: task, runs.map(::row)) }

    fun sections(list: List<Session>) = list.map(::row)
        .groupBy { it.rollup }
        .let { byCategory ->
            Category.entries.mapNotNull { c ->
                byCategory[c]?.sortedWith(
                    compareByDescending<LeaderRow> { it.session.pinned }.thenByDescending { it.session.lastActivity },
                )?.let { StatusSection(c, it) }
            }
        }

    val known = workspaces.sortedBy { it.position }
    val groups = if (known.isEmpty()) {
        listOf(WorkspaceGroup(null, sections(regular)))
    } else {
        // A session in a workspace the list does not have yet goes with the first.
        val byWorkspace = regular.groupBy { s -> known.firstOrNull { it.id == s.workspace } ?: known.first() }
        known.mapNotNull { w -> byWorkspace[w]?.let { WorkspaceGroup(w, sections(it)) } }
    }
    return SessionList(groups.filter { it.count > 0 }, tasks)
}
