package dev.aura.android.ui.components

import androidx.annotation.StringRes
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalResources
import kotlinx.coroutines.flow.Flow

/** Something to tell the user in a snackbar: a string resource, or text from the server. */
sealed interface UiMessage {
    data class Res(@StringRes val id: Int, val args: List<Any> = emptyList()) : UiMessage
    data class Text(val text: String) : UiMessage
}

/** Shows each of [messages] in [host] as it comes. */
@Composable
fun SnackbarMessages(messages: Flow<UiMessage>, host: SnackbarHostState) {
    val resources = LocalResources.current
    LaunchedEffect(messages, host) {
        messages.collect { message ->
            val text = when (message) {
                is UiMessage.Res -> resources.getString(message.id, *message.args.toTypedArray())
                is UiMessage.Text -> message.text
            }
            host.showSnackbar(text)
        }
    }
}
