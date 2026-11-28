package dev.aura.android.widget

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.aura.android.AuraApplication
import dev.aura.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** A Quick Settings tile: how many things wait on the user; tap opens the inbox. */
class WaitingTileService : TileService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watch: Job? = null

    override fun onStartListening() {
        val waiting = (application as AuraApplication).container.waiting
        watch?.cancel()
        watch = scope.launch { waiting.snapshot.collect(::show) }
    }

    override fun onStopListening() {
        watch?.cancel()
        watch = null
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun show(s: WaitingSnapshot) {
        val tile = qsTile ?: return
        tile.icon = Icon.createWithResource(this, R.drawable.ic_notification)
        val count = if (s.count == 0) getString(R.string.tile_nothing) else resources.getQuantityString(R.plurals.widget_count, s.count, s.count)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.label = getString(R.string.app_name)
            tile.subtitle = count
        } else {
            tile.label = count
        }
        tile.state = if (s.count == 0) Tile.STATE_INACTIVE else Tile.STATE_ACTIVE
        tile.updateTile()
    }

    override fun onClick() {
        val intent = inboxIntent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            collapseAndStart(intent)
        }
    }

    /** Before Android 14 the tile can only start an Intent. */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun collapseAndStart(intent: Intent) = startActivityAndCollapse(intent)

    companion object {
        /** Asks the system to refresh the tile now if it is showing; it also refreshes each time Quick Settings opens. */
        fun refresh(context: Context) {
            requestListeningState(context, ComponentName(context, WaitingTileService::class.java))
        }
    }
}
