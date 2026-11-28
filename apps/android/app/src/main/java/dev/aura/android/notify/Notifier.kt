package dev.aura.android.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import dev.aura.android.MainActivity
import dev.aura.android.R
import dev.aura.android.data.AppPrefs
import dev.aura.android.data.SavedServer
import dev.aura.android.net.ServerConnection
import dev.aura.android.transcript.plainText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The session open on screen, whose news is not notified. */
data class OpenSession(val serverId: String, val sessionId: String)

/**
 * Posts and withdraws the app's notifications as the servers change: decisions,
 * replies of main chats, approvals and questions (see [activeNotices]). One
 * watcher per connection; notified keys are kept in [prefs] so a reconnect or
 * a restart does not notify the same thing again.
 */
class Notifier(
    private val context: Context,
    private val prefs: AppPrefs,
    private val scope: CoroutineScope,
    private val openSession: StateFlow<OpenSession?>,
) {
    private val manager = NotificationManagerCompat.from(context)
    private val watchers = HashMap<String, Job>()
    private val posted = HashMap<String, MutableSet<String>>()
    private val lock = Mutex()

    init {
        createChannels(context)
    }

    /** Watches [connection] (replacing an earlier watcher for its server). */
    fun watch(connection: ServerConnection) {
        val server = connection.server
        watchers.remove(server.id)?.cancel()
        watchers[server.id] = scope.launch {
            combine(
                combine(connection.sessions.filterNotNull(), connection.features.filterNotNull(), connection.pending.filterNotNull(), ::Triple),
                connection.lastReplies,
                openSession,
            ) { (sessions, features, pending), replies, open ->
                ServerView(server.id, sessions, features, pending, replies) to open?.takeIf { it.serverId == server.id }?.sessionId
            }.collect { (view, openId) -> update(server, view, openId) }
        }
    }

    /** Stops watching [serverId] and takes its notifications away. */
    fun forget(serverId: String) {
        watchers.remove(serverId)?.cancel()
        posted.remove(serverId)?.forEach { manager.cancel(it, NOTICE_ID) }
        manager.cancel(summaryTag(serverId), NOTICE_ID)
        scope.launch { prefs.forget(serverId) }
    }

    /** Takes away the notification [key] (after acting on it from the notification). */
    fun dismiss(serverId: String, key: String) {
        posted[serverId]?.remove(key)
        manager.cancel(key, NOTICE_ID)
    }

    private suspend fun update(server: SavedServer, view: ServerView, openId: String?) = lock.withLock {
        val shown = posted.getOrPut(server.id) { mutableSetOf() }
        val result = noticeUpdate(
            active = activeNotices(view),
            seen = prefs.seen(server.id),
            posted = shown,
            baseline = !prefs.isBaselined(server.id),
            openSessionId = openId,
        )
        prefs.saveSeen(server.id, result.seen)
        result.cancel.forEach { manager.cancel(it, NOTICE_ID); shown.remove(it) }
        // What is on screen needs no notification any more.
        if (openId != null) {
            activeNotices(view).filter { it.sessionId == openId && it.key in shown }.forEach { manager.cancel(it.key, NOTICE_ID); shown.remove(it.key) }
        }
        for (notice in result.post) {
            if (post(notice.key, build(server, notice))) shown += notice.key
        }
        if (shown.isEmpty()) manager.cancel(summaryTag(server.id), NOTICE_ID) else post(summaryTag(server.id), summary(server))
    }

    /** Posts [notification] under [tag] when the user allows notifications; whether it was. */
    private fun post(tag: String, notification: Notification): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        manager.notify(tag, NOTICE_ID, notification)
        return true
    }

    private fun build(server: SavedServer, notice: Notice) = NotificationCompat.Builder(context, notice.kind.channel)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(notice.title.ifBlank { context.getString(R.string.untitled_session) })
        .setContentText(contentText(notice))
        .setStyle(NotificationCompat.BigTextStyle().bigText(contentText(notice)))
        .setSubText(server.name)
        .setCategory(if (notice.kind == NoticeKind.Message) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_REMINDER)
        .setGroup(groupOf(server.id))
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openIntent(context, server.id, notice.sessionId, notice.key))
        .apply {
            when (notice.kind) {
                NoticeKind.Message -> addAction(replyAction(server.id, notice))
                NoticeKind.Approval -> notice.approvalId?.let { approval ->
                    addAction(0, context.getString(R.string.allow), actionIntent(NotificationActions.APPROVE, server.id, notice, approval))
                    addAction(0, context.getString(R.string.decline), actionIntent(NotificationActions.DECLINE, server.id, notice, approval))
                }
                else -> {}
            }
        }
        .build()

    private fun contentText(notice: Notice): String = when (notice.kind) {
        NoticeKind.Decision -> context.getString(R.string.notice_decision, notice.text)
        NoticeKind.Message -> plainText(notice.text).ifBlank {
            context.getString(if (notice.failed) R.string.notice_failed else R.string.notice_finished)
        }
        NoticeKind.Approval -> context.getString(R.string.notice_approval, notice.text)
        NoticeKind.Question -> context.getString(R.string.notice_question, notice.text)
    }

    private fun summary(server: SavedServer) = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
        .setSmallIcon(R.drawable.ic_notification)
        .setSubText(server.name)
        .setGroup(groupOf(server.id))
        .setGroupSummary(true)
        .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
        .setAutoCancel(true)
        .build()

    private fun replyAction(serverId: String, notice: Notice): NotificationCompat.Action {
        val input = RemoteInput.Builder(NotificationActions.EXTRA_REPLY).setLabel(context.getString(R.string.reply_hint)).build()
        // Mutable: the system adds the typed reply to it. The intent is explicit, to this app's receiver.
        val intent = PendingIntent.getBroadcast(
            context,
            notice.key.hashCode(),
            NotificationActions.intent(context, NotificationActions.REPLY, serverId, notice.sessionId, notice.key),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        return NotificationCompat.Action.Builder(0, context.getString(R.string.reply), intent)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .build()
    }

    private fun actionIntent(action: String, serverId: String, notice: Notice, approval: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        (action + notice.key).hashCode(),
        NotificationActions.intent(context, action, serverId, notice.sessionId, notice.key).putExtra(NotificationActions.EXTRA_APPROVAL, approval),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        const val CHANNEL_DECISIONS = "decisions"
        const val CHANNEL_MESSAGES = "messages"
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_CONNECTION = "connection"
        const val NOTICE_ID = 1

        private val NoticeKind.channel: String
            get() = when (this) {
                NoticeKind.Decision -> CHANNEL_DECISIONS
                NoticeKind.Message -> CHANNEL_MESSAGES
                NoticeKind.Approval, NoticeKind.Question -> CHANNEL_APPROVALS
            }

        private fun groupOf(serverId: String) = "server:$serverId"
        private fun summaryTag(serverId: String) = "summary:$serverId"

        /** Opens session [sessionId] of [serverId] in the app (the leader, on that worker's tab). */
        fun openIntent(context: Context, serverId: String, sessionId: String, key: String): PendingIntent = PendingIntent.getActivity(
            context,
            key.hashCode(),
            Intent(context, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OPEN_SESSION)
                .putExtra(MainActivity.EXTRA_SERVER, serverId)
                .putExtra(MainActivity.EXTRA_SESSION, sessionId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun createChannels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            nm.createNotificationChannels(
                listOf(
                    NotificationChannel(CHANNEL_DECISIONS, context.getString(R.string.channel_decisions), NotificationManager.IMPORTANCE_HIGH)
                        .apply { description = context.getString(R.string.channel_decisions_desc) },
                    NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_DEFAULT)
                        .apply { description = context.getString(R.string.channel_messages_desc) },
                    NotificationChannel(CHANNEL_APPROVALS, context.getString(R.string.channel_approvals), NotificationManager.IMPORTANCE_HIGH)
                        .apply { description = context.getString(R.string.channel_approvals_desc) },
                    NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN)
                        .apply { description = context.getString(R.string.channel_connection_desc) },
                ),
            )
        }
    }
}
