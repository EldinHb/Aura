package dev.aura.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.provider.Settings
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.aura.android.data.FoldedGroups
import dev.aura.android.data.KeystoreCipher
import dev.aura.android.data.SavedServer
import dev.aura.android.data.ServerStore
import dev.aura.android.net.ServerConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

private val Context.dataStore by preferencesDataStore(name = "aura")

/**
 * The app's long-lived objects: the saved servers and one connection per
 * server. Connections run while the app is in the foreground and stop when it
 * leaves it; a network that comes back retries them at once.
 */
class AppContainer(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http = OkHttpClient()
    val store = ServerStore(context.dataStore, KeystoreCipher())
    val folded = FoldedGroups(context.dataStore)

    private val _connections = MutableStateFlow<Map<String, ServerConnection>>(emptyMap())

    /** One connection per saved server, by the server's local id. */
    val connections: StateFlow<Map<String, ServerConnection>> = _connections

    @Volatile private var foreground = false

    init {
        scope.launch { store.servers.collect(::sync) }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground = true
                _connections.value.values.forEach { it.start() }
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground = false
                _connections.value.values.forEach { it.stop() }
            }
        })
        context.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (foreground) _connections.value.values.forEach { it.retryNow() }
                }
            },
        )
    }

    /** Connects to the servers in [servers], dropping connections to ones removed or changed. */
    private fun sync(servers: List<SavedServer>) {
        val current = _connections.value
        val next = servers.associate { server ->
            val existing = current[server.id]
            server.id to if (existing != null && existing.server.sameEndpoint(server)) {
                existing
            } else {
                existing?.stop()
                ServerConnection(server, store.token(server), http, scope).also { if (foreground) it.start() }
            }
        }
        current.filterKeys { it !in next }.values.forEach { it.stop() }
        _connections.value = next
    }

    fun connection(serverId: String): ServerConnection? = _connections.value[serverId]

    /** A name the server shows for this device. */
    val deviceName: String
        get() = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            ?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}

/** Whether a connection to [other] is the same as one to this: everything but the display name. */
private fun SavedServer.sameEndpoint(other: SavedServer) = copy(name = other.name) == other
