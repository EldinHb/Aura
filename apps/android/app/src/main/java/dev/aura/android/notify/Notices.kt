package dev.aura.android.notify

import dev.aura.android.data.NoticeSettings
import dev.aura.android.net.Prompts
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Forest
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.Session

/** What a notification is about; each has its own channel. */
enum class NoticeKind { Decision, Message, Approval, Question }

/**
 * Something on a server the user should hear about. [key] is stable for the
 * same thing across reconnects and reloads, so it is notified once.
 * [sessionId] is the session to open (a worker's tab, when it is a worker's).
 */
data class Notice(
    val key: String,
    val kind: NoticeKind,
    val serverId: String,
    val sessionId: String,
    val title: String,
    val text: String,
    val approvalId: String? = null,
    val failed: Boolean = false,
    /** Part of a scheduled task's run. */
    val scheduled: Boolean = false,
    /** Whether it may be notified now, or only kept when it already is. */
    val postable: Boolean = true,
)

/** What one server shows, as far as notifications go. */
data class ServerView(
    val serverId: String,
    val sessions: List<Session>,
    val features: List<Feature>,
    val pending: Pending,
    /** The latest agent message per session, as seen live. */
    val lastReplies: Map<String, String> = emptyMap(),
    /** Per session, who sent its messages; absent when not known yet (see ServerConnection.prompts). */
    val prompts: Map<String, Prompts> = emptyMap(),
)

private val Session.isScheduled: Boolean get() = scheduledTaskId != null || scheduledRun != null

/** A main chat: not a worker or team member, even one whose orchestrator is gone. */
private fun Session.isMainChat(forest: Forest): Boolean =
    !archived && (orchestratorId == null || orchestratorId == id) && forest.parentOf(id) == null

/** Whether the agent of [this] finished (or failed) a turn the user has not seen. */
private val Session.finishedUnseen: Boolean get() = attention == "done" || attention == "failed"

/**
 * The main chats whose finished turn may be the user's, but who sent their
 * messages is not known yet: read it ([ServerView.prompts]) before deciding.
 */
fun promptLookups(view: ServerView, settings: NoticeSettings): List<String> {
    if (!settings.messages) return emptyList()
    val forest = Forest(view.sessions)
    return view.sessions
        .filter { it.isMainChat(forest) && it.finishedUnseen && it.id !in view.prompts && (settings.scheduled || !it.isScheduled) }
        .map { it.id }
}

/**
 * Everything on [view] that wants the user now:
 * - a feature owner's open question (a decision card);
 * - a main chat, a top-level session (not a worker or team member), whose
 *   agent finished (or failed) a turn the user started and that the user has
 *   not looked at since, here or on the desktop (the server's `attention`).
 *   Once per such turn: the turns Aura starts with its own messages (worker
 *   reports, answers, decisions fed to an orchestrator) are not the user's.
 *   While those run after the user's turn, its notice stays active (so a
 *   posted notification stays) but is not [Notice.postable];
 * - an approval or a question an agent waits on, in any session.
 * What stops wanting the user (answered, opened, resolved) drops out.
 */
fun activeNotices(view: ServerView): List<Notice> {
    val forest = Forest(view.sessions)
    val byId = view.sessions.associateBy { it.id }
    fun titleOf(id: String) = byId[id]?.title?.takeIf { it.isNotBlank() }.orEmpty()
    val out = mutableListOf<Notice>()
    for (feature in view.features) {
        for (q in feature.questions.filter { it.open }) {
            out += Notice(
                key = "decision:${feature.ownerId}:${q.id}",
                kind = NoticeKind.Decision,
                serverId = view.serverId,
                sessionId = feature.ownerId,
                title = titleOf(feature.ownerId).ifEmpty { feature.goal },
                text = q.question,
            )
        }
    }
    for (s in view.sessions) {
        if (!s.isMainChat(forest) || !s.finishedUnseen) continue
        val prompts = view.prompts[s.id] ?: continue
        val turn = prompts.userTurn ?: continue
        out += Notice(
            key = "message:${s.id}:$turn",
            kind = NoticeKind.Message,
            serverId = view.serverId,
            sessionId = s.id,
            title = s.title,
            text = view.lastReplies[s.id] ?: s.lastError.orEmpty(),
            failed = s.attention == "failed",
            scheduled = s.isScheduled,
            postable = prompts.latestFromUser,
        )
    }
    for (a in view.pending.approvals) {
        out += Notice(
            key = "approval:${a.id}",
            kind = NoticeKind.Approval,
            serverId = view.serverId,
            sessionId = a.sessionId,
            title = titleOf(a.sessionId),
            text = a.title,
            approvalId = a.id,
            scheduled = byId[a.sessionId]?.isScheduled == true,
        )
    }
    for (r in view.pending.inputs) {
        out += Notice(
            key = "question:${r.id}",
            kind = NoticeKind.Question,
            serverId = view.serverId,
            sessionId = r.sessionId,
            title = titleOf(r.sessionId),
            text = r.questions.joinToString("\n") { it.question },
            scheduled = byId[r.sessionId]?.isScheduled == true,
        )
    }
    return out
}

/** What to do with a server's notices after a change. */
data class NoticeUpdate(
    /** New: post them. */
    val post: List<Notice>,
    /** No longer active: take their notifications away. */
    val cancel: Set<String>,
    /** The keys to remember as notified from now on. */
    val seen: Set<String>,
)

/**
 * Decides what to post: the active notices not notified before. The first
 * time a server is seen ([baseline]), what is already there is taken as known
 * and not notified, so pairing does not bring a burst of old news. A notice
 * about the session open on screen ([openSessionId]) is taken as seen.
 */
fun noticeUpdate(active: List<Notice>, seen: Set<String>, posted: Set<String>, baseline: Boolean, openSessionId: String?): NoticeUpdate {
    val keys = active.map { it.key }.toSet()
    val fresh = active.filter { it.key !in seen && it.postable }
    val post = if (baseline) emptyList() else fresh.filter { it.sessionId != openSessionId }
    return NoticeUpdate(
        post = post,
        cancel = posted - keys,
        // Keys no longer active are kept a while, so a reload that brings one back does not notify it again.
        seen = (seen + keys).let { if (it.size > MAX_SEEN) it.toList().takeLast(MAX_SEEN).toSet() else it },
    )
}

private const val MAX_SEEN = 2000

/**
 * Whether the user wants [notice] notified, by [settings]. "Scheduled tasks"
 * governs the replies of scheduled runs; an approval or question in one still
 * blocks it, so it follows "Approvals".
 */
fun NoticeSettings.wants(notice: Notice): Boolean = when (notice.kind) {
    NoticeKind.Decision -> decisions
    NoticeKind.Message -> messages && (scheduled || !notice.scheduled)
    NoticeKind.Approval, NoticeKind.Question -> approvals
}
