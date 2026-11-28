package dev.aura.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import dev.aura.android.pairing.PairingLink
import dev.aura.android.ui.AuraApp
import dev.aura.android.ui.theme.AuraTheme
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

/** What the app was opened with: a pairing link, or a session from a notification. */
sealed interface AppLink {
    data class Pair(val link: String) : AppLink
    data class Session(val serverId: String, val sessionId: String) : AppLink
    data class Share(val images: List<Uri>) : AppLink
    data object Inbox : AppLink
}

class MainActivity : ComponentActivity() {
    private val appLinks = Channel<AppLink>(Channel.BUFFERED)
    private val links = appLinks.receiveAsFlow()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) takeLink(intent)
        setContent {
            AuraTheme {
                AuraApp(links)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    private fun takeLink(intent: Intent?) {
        intent ?: return
        if (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val images = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?: listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            if (images.isNotEmpty()) appLinks.trySend(AppLink.Share(images))
            return
        }
        if (intent.action == ACTION_OPEN_INBOX) {
            appLinks.trySend(AppLink.Inbox)
            return
        }
        if (intent.action == ACTION_OPEN_SESSION) {
            val server = intent.getStringExtra(EXTRA_SERVER) ?: return
            val session = intent.getStringExtra(EXTRA_SESSION) ?: return
            appLinks.trySend(AppLink.Session(server, session))
            return
        }
        val data = intent.data ?: return
        if (data.scheme == PairingLink.SCHEME && data.host == PairingLink.HOST) appLinks.trySend(AppLink.Pair(data.toString()))
    }

    companion object {
        const val ACTION_OPEN_SESSION = "dev.aura.android.action.OPEN_SESSION"
        const val ACTION_OPEN_INBOX = "dev.aura.android.action.OPEN_INBOX"
        const val EXTRA_SERVER = "server"
        const val EXTRA_SESSION = "session"
    }
}
