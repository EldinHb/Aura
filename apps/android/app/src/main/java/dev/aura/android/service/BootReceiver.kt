package dev.aura.android.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.aura.android.AuraApplication
import kotlinx.coroutines.launch

/** After a reboot (or an update of the app), stays connected again when the user chose so. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val container = (context.applicationContext as AuraApplication).container
        val done = goAsync()
        container.scope.launch {
            try {
                if (container.shouldStayConnected()) ConnectionService.start(context)
            } finally {
                done.finish()
            }
        }
    }
}
