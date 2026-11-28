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
