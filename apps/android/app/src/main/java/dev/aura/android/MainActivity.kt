package dev.aura.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.aura.android.pairing.PairingLink
import dev.aura.android.ui.AuraApp
import dev.aura.android.ui.theme.AuraTheme
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

class MainActivity : ComponentActivity() {
    /** `aura://pair` links the app is opened with, for the UI to take. */
    private val pairingLinks = Channel<String>(Channel.BUFFERED)
    private val links = pairingLinks.receiveAsFlow()

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
        val data = intent?.data ?: return
        if (data.scheme == PairingLink.SCHEME && data.host == PairingLink.HOST) pairingLinks.trySend(data.toString())
    }
}
