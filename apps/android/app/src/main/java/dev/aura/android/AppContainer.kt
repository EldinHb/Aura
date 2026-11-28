package dev.aura.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.aura.android.data.AppPrefs
import dev.aura.android.data.FoldedGroups
import dev.aura.android.data.KeystoreCipher
import dev.aura.android.data.SavedServer
import dev.aura.android.data.ServerStore
import dev.aura.android.net.ServerConnection
import dev.aura.android.notify.Notifier
import dev.aura.android.notify.OpenSession
import dev.aura.android.service.ConnectionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

private val Context.dataStore by preferencesDataStore(name = "aura")

/**
 * The app's long-lived objects: the saved servers, one connection per server,
 * and the notifications. Connections run while the app is in the foreground;
 * with "Stay connected in background" on, [ConnectionService] keeps them
 * running after it leaves, so news is notified. A network that comes back
 * retries them at once.
 */
class AppContainer(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http = OkHttpClient()
    val store = ServerStore(context.dataStore, KeystoreCipher())
    val folded = FoldedGroups(context.dataStore)
    val prefs = AppPrefs(context.dataStore)

    /** The session open on screen; its news is not notified. */
    val openSession = MutableStateFlow<OpenSession?>(null)

    /** Images shared to Aura from another app, waiting for the session they were shared into: by "server/session". */
    val sharedImages = MutableStateFlow<Map<String, List<android.net.Uri>>>(emptyMap())

    /** Text waiting to go into a session's composer ("Ask for changes"), by "server/session". */
    val composerPrefill = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Reads and shrinks images to send. */
    val images = dev.aura.android.images.ImageEncoder(context.contentResolver)

    val notifier = Notifier(context, prefs, scope, openSession)

    private val _connections = MutableStateFlow<Map<String, ServerConnection>>(emptyMap())

    /** One connection per saved server, by the server's local id. */
    val connections: StateFlow<Map<String, ServerConnection>> = _connections

    private val _notificationsGranted = MutableStateFlow(notificationsAllowed())

    /** Whether the app may post notifications (asked for on Android 13 and later). */
    val notificationsGranted: StateFlow<Boolean> = _notificationsGranted

    /** "Stay connected in background": the user's choice, or on once notifications are allowed. */
    val backgroundEnabled: StateFlow<Boolean> = combine(prefs.backgroundChoice, _notificationsGranted) { choice, granted -> choice ?: granted }
        .stateIn(scope, SharingStarted.Eagerly, false)

    @Volatile private var foreground = false

    init {
        scope.launch { store.servers.collect(::sync) }
        scope.launch {
            combine(backgroundEnabled, store.servers) { on, servers -> on && servers.isNotEmpty() }.collect { keep ->
                if (keep) {
                    if (foreground) ConnectionService.start(context)
                } else {
                    ConnectionService.stop(context)
                    if (!foreground) _connections.value.values.forEach { it.stop() }
                }
            }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground = true
                refreshNotificationPermission()
                _connections.value.values.forEach { it.start() }
                if (keepConnected()) ConnectionService.start(context)
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground = false
                if (!keepConnected()) _connections.value.values.forEach { it.stop() }
            }
        })
        context.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (foreground || keepConnected()) _connections.value.values.forEach { it.retryNow() }
                }
            },
        )
    }

    /** Whether connections stay up while the app is in the background. */
    private fun keepConnected() = backgroundEnabled.value && _connections.value.isNotEmpty()

    /** Starts every connection; for the service, which keeps them up in the background. */
    fun startAll() {
        _connections.value.values.forEach { it.start() }
    }

    /** Whether the service should run now, read from storage: for a start after boot. */
    suspend fun shouldStayConnected(): Boolean = backgroundOn() && store.all().isNotEmpty()

    private suspend fun backgroundOn(): Boolean = prefs.backgroundChoice.first() ?: notificationsAllowed()

    suspend fun setBackground(on: Boolean) = prefs.setBackground(on)

    /** Called after the notification permission was asked for, and on each return to the app. */
    fun refreshNotificationPermission() {
        _notificationsGranted.value = notificationsAllowed()
    }

    private fun notificationsAllowed(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Connects to the servers in [servers], dropping connections to ones removed or changed. */
    private fun sync(servers: List<SavedServer>) {
        val current = _connections.value
        val next = servers.associate { server ->
            val existing = current[server.id]
            server.id to if (existing != null && existing.server.sameEndpoint(server)) {
                existing
            } else {
                existing?.stop()
                ServerConnection(server, store.token(server), http, scope).also {
                    notifier.watch(it)
                    if (foreground || keepConnected()) it.start()
                }
            }
        }
        current.filterKeys { it !in next }.forEach { (id, c) ->
            c.stop()
            notifier.forget(id)
        }
        _connections.value = next
    }

    fun connection(serverId: String): ServerConnection? = _connections.value[serverId]

    /** A name the server shows for this device. */
    val deviceName: String
        get() = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            ?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    /** Opens the app's notification settings, where the user can allow what Android asked. */
    fun notificationSettingsIntent(): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/** Whether a connection to [other] is the same as one to this: everything but the display name. */
private fun SavedServer.sameEndpoint(other: SavedServer) = copy(name = other.name) == other
