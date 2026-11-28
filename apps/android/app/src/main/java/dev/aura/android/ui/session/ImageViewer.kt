package dev.aura.android.ui.session

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.aura.android.R
import dev.aura.android.images.MessageImage
import dev.aura.android.images.decodeImage
import dev.aura.android.ui.theme.Spacing

/** A sent image, full screen: the thumbnail at once, the whole image once loaded. */
@Composable
fun ImageViewer(image: MessageImage, load: suspend (String) -> Bitmap?, onDismiss: () -> Unit) {
    val preview = remember(image.key) { image.thumbnail?.let(::decodeImage) }
    var full by remember(image.key) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(image.key) { mutableStateOf(false) }
    LaunchedEffect(image.key) {
        image.attachment?.let { id -> full = load(id) ?: run { failed = true; null } }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim), contentAlignment = Alignment.Center) {
            (full ?: preview)?.let {
                Image(it.asImageBitmap(), contentDescription = image.name ?: stringResource(R.string.image), contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            }
            if (full == null && image.attachment != null && !failed) CircularProgressIndicator()
            if (failed && preview == null) Text(stringResource(R.string.image_loading_failed), color = MaterialTheme.colorScheme.inverseOnSurface)
            // On its own container, so it reads over any image.
            FilledTonalIconButton(onClick = onDismiss, modifier = Modifier.align(Alignment.TopEnd).windowInsetsPadding(WindowInsets.statusBars).padding(Spacing.m)) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.close))
            }
        }
    }
}
