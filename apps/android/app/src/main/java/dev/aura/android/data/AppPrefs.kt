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
    private val baselined = stringSetPreferencesKey("notices_baselined")
    private fun seenKey(serverId: String) = stringPreferencesKey("notices_seen:$serverId")
    private val keys = ListSerializer(String.serializer())

    /** "Stay connected in background", or null when the user never chose (then it follows notification permission). */
    val backgroundChoice: Flow<Boolean?> = store.data.map { it[background] }

    suspend fun setBackground(on: Boolean) {
        store.edit { it[background] = on }
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
