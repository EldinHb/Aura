package dev.aura.android.widget

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import dev.aura.android.net.ProtocolJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** The saved [WaitingSnapshot]. */
class WaitingStore(private val store: DataStore<Preferences>) {
    private val key = stringPreferencesKey("waiting_snapshot")

    val snapshot: Flow<WaitingSnapshot> = store.data.map { prefs ->
        prefs[key]?.let { runCatching { ProtocolJson.decodeFromString(WaitingSnapshot.serializer(), it) }.getOrNull() } ?: WaitingSnapshot()
    }

    suspend fun current(): WaitingSnapshot = snapshot.first()

    /** Saves [s]; whether it changed. */
    suspend fun save(s: WaitingSnapshot): Boolean {
        if (current() == s) return false
        store.edit { it[key] = ProtocolJson.encodeToString(WaitingSnapshot.serializer(), s) }
        return true
    }
}
