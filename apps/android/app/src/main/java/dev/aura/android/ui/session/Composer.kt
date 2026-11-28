package dev.aura.android.ui.session

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import dev.aura.android.R
import dev.aura.android.images.DraftImage
import dev.aura.android.ui.components.ProseKeyboard
import dev.aura.android.ui.theme.Spacing

/** The most lines the composer grows to before it scrolls. */
private const val COMPOSER_MAX_LINES = 6

/** The most images picked at once, as the system photo picker allows. */
private const val MAX_PICKED = 10

/**
 * What the user writes to the agent: text and, from the photo picker (no
 * permission needed), images, shown as thumbnails that can be taken out
 * before sending. Images alone can be sent.
 */
@Composable
fun Composer(
    enabled: Boolean,
    sending: Boolean,
    drafts: List<DraftImage>,
    preparing: Int,
    onAttach: (List<Uri>) -> Unit,
    onRemove: (String) -> Unit,
    onSend: (String, () -> Unit) -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICKED)) { uris ->
        if (uris.isNotEmpty()) onAttach(uris)
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                .padding(horizontal = Spacing.m, vertical = Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            if (drafts.isNotEmpty() || preparing > 0) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    items(drafts, key = { it.id }) { d -> DraftThumb(d, onRemove = { onRemove(d.id) }) }
                    items(preparing) {
                        Box(Modifier.size(Spacing.thumb), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                IconButton(
                    onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    enabled = enabled,
                    modifier = Modifier.padding(bottom = Spacing.xs),
                ) {
                    Icon(Icons.Outlined.AddPhotoAlternate, contentDescription = stringResource(R.string.attach_images))
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text(stringResource(R.string.message_placeholder)) },
                    keyboardOptions = ProseKeyboard,
                    maxLines = COMPOSER_MAX_LINES,
                    shape = MaterialTheme.shapes.extraLarge,
                    modifier = Modifier.weight(1f),
                )
                FilledIconButton(
                    onClick = { onSend(text) { text = "" } },
                    enabled = enabled && preparing == 0 && (text.isNotBlank() || drafts.isNotEmpty()),
                    modifier = Modifier.padding(bottom = Spacing.xs),
                ) {
                    if (sending) {
                        CircularProgressIndicator(Modifier.padding(Spacing.s))
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.send))
                    }
                }
            }
        }
    }
}

@Composable
private fun DraftThumb(draft: DraftImage, onRemove: () -> Unit) {
    val bitmap = remember(draft.id) { draft.preview.asImageBitmap() }
    Box(Modifier.size(Spacing.thumb)) {
        Image(
            bitmap = bitmap,
            contentDescription = draft.input.name ?: stringResource(R.string.image),
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(Spacing.thumb).clip(MaterialTheme.shapes.medium),
        )
        FilledTonalIconButton(
            onClick = onRemove,
            colors = IconButtonDefaults.filledTonalIconButtonColors(),
            modifier = Modifier.align(Alignment.TopEnd).size(Spacing.l),
        ) {
            Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.remove_image, draft.input.name ?: stringResource(R.string.image)), modifier = Modifier.size(Spacing.m))
        }
    }
}
