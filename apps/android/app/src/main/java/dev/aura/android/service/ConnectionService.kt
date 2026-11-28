package dev.aura.android.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.aura.android.AuraApplication
import dev.aura.android.MainActivity
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.notify.Notifier
import dev.aura.android.ui.servers.connectionStates
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps the server connections open while the app is in the background, so
 * decisions, replies and approvals are notified. A foreground service of type
 * `remoteMessaging`: it relays messages from the user's own computer, which
 * is what that type is for; it has no daily time limit (unlike `dataSync` on
 * Android 15), and it may be started after boot. Its notification, on a
 * minimal channel, says how many servers are connected.
 *
 * It holds no wake lock: an idle connection costs nothing, the network wakes
 * the phone when a message comes, and a connection lost in Doze is retried
 * with backoff (and at once when the network is back).
 */
class ConnectionService : Service() {
    private var watcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val container = (application as AuraApplication).container
        // The type exists from Android 14 on; before that a foreground service has none to declare.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, ONGOING_ID, ongoing(0, 0), type)
        container.startAll()
        if (watcher == null) {
            watcher = container.scope.launch {
                combine(container.connectionStates(), container.backgroundEnabled) { states, on -> states to on }.collect { (states, on) ->
                    if (!on || states.isEmpty()) {
                        stopSelf()
                    } else {
                        val online = states.values.count { it is ConnectionState.Online }
                        getSystemService(NotificationManager::class.java)?.notify(ONGOING_ID, ongoing(online, states.size))
                    }
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        watcher?.cancel()
        watcher = null
        super.onDestroy()
    }

    private fun ongoing(online: Int, total: Int): Notification {
        val text = when {
            total == 0 -> getString(R.string.service_starting)
            online == 0 -> getString(R.string.service_reconnecting)
            else -> resources.getQuantityString(R.plurals.service_connected, online, online)
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, Notifier.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }

    companion object {
        private const val ONGOING_ID = 7443

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
