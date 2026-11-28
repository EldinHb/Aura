package dev.aura.android.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import dev.aura.android.net.ProtocolJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

/** The app's own settings, and what it remembers about notifications. */
class AppPrefs(private val store: DataStore<Preferences>) {
    private val background = booleanPreferencesKey("background")
    private val askedNotifications = booleanPreferencesKey("asked_notifications")
    // v2: Message keys became per user turn; taking what is there as known once keeps the update quiet.
    private val baselined = stringSetPreferencesKey("notices_baselined_v2")
    private val notifyDecisions = booleanPreferencesKey("notify_decisions")
    private val notifyMessages = booleanPreferencesKey("notify_messages")
    private val notifyApprovals = booleanPreferencesKey("notify_approvals")
    private val notifyScheduled = booleanPreferencesKey("notify_scheduled")
    private fun seenKey(serverId: String) = stringPreferencesKey("notices_seen:$serverId")
    private val keys = ListSerializer(String.serializer())

    /** "Stay connected in background", or null when the user never chose (then it follows notification permission). */
    val backgroundChoice: Flow<Boolean?> = store.data.map { it[background] }

    suspend fun setBackground(on: Boolean) {
        store.edit { it[background] = on }
    }

    /** Which notifications the user wants. */
    val noticeSettings: Flow<NoticeSettings> = store.data.map {
        NoticeSettings(
            decisions = it[notifyDecisions] ?: true,
            messages = it[notifyMessages] ?: true,
            approvals = it[notifyApprovals] ?: true,
            scheduled = it[notifyScheduled] ?: false,
        )
    }

    suspend fun setNoticeSettings(s: NoticeSettings) {
        store.edit {
            it[notifyDecisions] = s.decisions
            it[notifyMessages] = s.messages
            it[notifyApprovals] = s.approvals
            it[notifyScheduled] = s.scheduled
        }
    }

    val notificationsAsked: Flow<Boolean> = store.data.map { it[askedNotifications] == true }

    suspend fun setNotificationsAsked() {
        store.edit { it[askedNotifications] = true }
    }

    /** Whether [serverId]'s notices were ever taken in (after that, new ones are notified). */
    suspend fun isBaselined(serverId: String): Boolean = serverId in store.data.first()[baselined].orEmpty()

    /** The notice keys already notified (or known) for [serverId], oldest first. */
    suspend fun seen(serverId: String): Set<String> =
        store.data.first()[seenKey(serverId)]?.let { runCatching { ProtocolJson.decodeFromString(keys, it) }.getOrNull() }.orEmpty().toSet()

    suspend fun saveSeen(serverId: String, seen: Set<String>) {
        store.edit {
            it[seenKey(serverId)] = ProtocolJson.encodeToString(keys, seen.toList())
            it[baselined] = it[baselined].orEmpty() + serverId
        }
    }

    suspend fun forget(serverId: String) {
        store.edit {
            it.remove(seenKey(serverId))
            it[baselined] = it[baselined].orEmpty() - serverId
        }
    }
}

/**
 * Which notifications the user wants: feature owners' decisions, main chats'
 * replies, approvals and agents' questions, and replies of scheduled tasks' runs.
 */
data class NoticeSettings(
    val decisions: Boolean = true,
    val messages: Boolean = true,
    val approvals: Boolean = true,
    val scheduled: Boolean = false,
)
