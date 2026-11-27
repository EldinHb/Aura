package dev.aura.android.protocol

/** A session's state as the user cares about it, most urgent first. */
enum class SessionState {
    Waiting,
    Running,
    Failed,
    Done,
    Idle,
}

val Session.state: SessionState
    get() = when {
        pendingCount > 0 || status == "waiting_approval" || status == "waiting_input" || attention == "waiting" -> SessionState.Waiting
        status == "running" -> SessionState.Running
        attention == "failed" || status == "error" -> SessionState.Failed
        attention == "done" || status == "exited" -> SessionState.Done
        else -> SessionState.Idle
    }

/** The folder or repository the session works in: a worktree counts as its repository. */
val Session.projectPath: String
    get() = worktree?.repoRoot ?: cwd

/** The last part of a path, for labels. */
fun folderName(path: String): String =
    path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifEmpty { path }

/** Whether this app can show the session's transcript: terminal sessions are bytes on a screen. */
val Session.isStructured: Boolean
    get() = mode != "terminal" && provider != "terminal"

/** Sessions to show, waiting ones first, then running, then by latest activity. */
fun List<Session>.ordered(): List<Session> =
    filterNot { it.archived }.sortedWith(
        compareBy<Session> { it.state.ordinal.coerceAtMost(SessionState.Failed.ordinal) }
            .thenByDescending { it.lastActivity },
    )

/** A project's sessions, for the list grouped by project. */
data class ProjectGroup(val path: String, val name: String, val sessions: List<Session>)

/** [sessions] grouped by project; the group with the most urgent session comes first. */
fun groupByProject(sessions: List<Session>): List<ProjectGroup> =
    sessions.ordered()
        .groupBy { it.projectPath }
        .map { (path, list) -> ProjectGroup(path, folderName(path), list) }
