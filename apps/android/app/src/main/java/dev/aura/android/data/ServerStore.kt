package dev.aura.android.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import dev.aura.android.net.ProtocolJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** A server this device paired with. */
@Serializable
data class SavedServer(
    /** This app's own id for the entry. */
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    /** SHA-256 of the server's certificate, lowercase hex. */
    val fingerprint: String,
    val serverId: String,
    val deviceId: String,
    /** The device token, sealed with [SecretCipher]; never stored in the clear. */
    val sealedToken: String,
) {
    val address: String get() = if (':' in host) "[$host]:$port" else "$host:$port"
}

/** The saved servers, in DataStore; their tokens sealed by [cipher]. */
class ServerStore(
    private val store: DataStore<Preferences>,
    private val cipher: SecretCipher,
) {
    private val key = stringPreferencesKey("servers")
    private val serializer = ListSerializer(SavedServer.serializer())

    val servers: Flow<List<SavedServer>> = store.data.map { prefs ->
        prefs[key]?.let { runCatching { ProtocolJson.decodeFromString(serializer, it) }.getOrNull() }.orEmpty()
    }

    suspend fun all(): List<SavedServer> = servers.first()

    /** The device token for [server], or null when it cannot be unsealed (the Keystore key is gone). */
    fun token(server: SavedServer): String? = runCatching { cipher.decrypt(server.sealedToken) }.getOrNull()

    fun seal(token: String): String = cipher.encrypt(token)

    /** Adds [server], or replaces the entry for the same server (by its server id). */
    suspend fun upsert(server: SavedServer) = update { list ->
        val existing = list.indexOfFirst { it.id == server.id || it.serverId == server.serverId }
        if (existing >= 0) list.toMutableList().also { it[existing] = server.copy(id = list[existing].id) } else list + server
    }

    suspend fun rename(id: String, name: String) = update { list -> list.map { if (it.id == id) it.copy(name = name) else it } }

    suspend fun remove(id: String) = update { list -> list.filterNot { it.id == id } }

    private suspend fun update(change: (List<SavedServer>) -> List<SavedServer>) {
        store.edit { prefs ->
            val current = prefs[key]?.let { runCatching { ProtocolJson.decodeFromString(serializer, it) }.getOrNull() }.orEmpty()
            prefs[key] = ProtocolJson.encodeToString(serializer, change(current))
        }
    }
}
