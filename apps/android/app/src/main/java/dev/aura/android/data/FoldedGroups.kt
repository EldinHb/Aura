package dev.aura.android.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** The groups of the session list the user folded, per server, kept across restarts as the desktop keeps them. */
class FoldedGroups(private val store: DataStore<Preferences>) {
    private fun key(serverId: String) = stringSetPreferencesKey("folded:$serverId")

    fun of(serverId: String): Flow<Set<String>> = store.data.map { it[key(serverId)].orEmpty() }

    suspend fun toggle(serverId: String, group: String) {
        store.edit { prefs ->
            val current = prefs[key(serverId)].orEmpty()
            prefs[key(serverId)] = if (group in current) current - group else current + group
        }
    }
}
