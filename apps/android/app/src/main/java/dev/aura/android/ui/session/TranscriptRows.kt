package dev.aura.android.ui.session

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Handyman
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.images.MessageImage
import dev.aura.android.images.decodeImage
import dev.aura.android.images.messageImages
import dev.aura.android.transcript.Row as TranscriptRow
import dev.aura.android.transcript.stepDetail
import dev.aura.android.transcript.stepLabel
import dev.aura.android.ui.components.CodeBlock
import dev.aura.android.ui.components.MarkdownText
import dev.aura.android.ui.theme.Spacing

/** The longest step detail shown; the rest is on the computer. */
private const val DETAIL_LIMIT = 4_000

/** How much of the width the user's own messages may take, so they read as replies. */
private const val USER_MESSAGE_WIDTH = 0.85f

@Composable
fun TranscriptRowView(
    row: TranscriptRow,
    modifier: Modifier = Modifier,
    featureCard: @Composable (TranscriptRow.Feature, Modifier) -> Unit = { _, _ -> },
    onOpenImage: (MessageImage) -> Unit = {},
    /** Shown under an agent reply, e.g. the usage of the turn it ends. */
    agentFooter: @Composable (TranscriptRow.Agent) -> Unit = {},
) {
    when (row) {
        is TranscriptRow.Aura -> AuraRow(row, modifier)
        is TranscriptRow.Feature -> featureCard(row, modifier)
        is TranscriptRow.User -> UserMessage(row.item.text, remember(row.item.data) { messageImages(row.item.data) }, onOpenImage, modifier)
        is TranscriptRow.Agent -> Column(modifier.fillMaxWidth()) {
            MarkdownText(
                row.item.text,
                Modifier.fillMaxWidth().padding(horizontal = Spacing.m),
                streaming = row.item.status == "in_progress",
            )
            agentFooter(row)
        }
        is TranscriptRow.Problem -> ProblemRow(row.item.text.ifBlank { row.item.stepLabel() }, modifier)
        is TranscriptRow.Work -> WorkRow(row, modifier)
    }
}

@Composable
private fun UserMessage(text: String, images: List<MessageImage>, onOpenImage: (MessageImage) -> Unit, modifier: Modifier) {
    Box(modifier.fillMaxWidth().padding(horizontal = Spacing.m), contentAlignment = Alignment.CenterEnd) {
        Column(Modifier.fillMaxWidth(USER_MESSAGE_WIDTH), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (images.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    images.forEach { MessageThumb(it, onOpen = { onOpenImage(it) }) }
                }
            }
            if (text.isNotBlank()) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    shape = MaterialTheme.shapes.large,
                ) {
                    MarkdownText(text, Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s))
                }
            }
        }
    }
}

/** A sent image's thumbnail; opens it whole when the daemon kept it. */
@Composable
private fun MessageThumb(image: MessageImage, onOpen: () -> Unit) {
    val bitmap = remember(image.thumbnail) { image.thumbnail?.let(::decodeImage)?.asImageBitmap() }
    val label = stringResource(R.string.open_image, image.name ?: stringResource(R.string.image))
    Surface(
        onClick = onOpen,
        enabled = image.thumbnail != null || image.attachment != null,
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.size(Spacing.thumb).semantics { contentDescription = label },
    ) {
        if (bitmap != null) {
            Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop)
        } else {
            Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Image, contentDescription = null) }
        }
    }
}

@Composable
private fun ProblemRow(text: String, modifier: Modifier) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Row(Modifier.padding(Spacing.m), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null)
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** A message Aura sent in the user's place: its title, opening to its text. */
@Composable
private fun AuraRow(row: TranscriptRow.Aura, modifier: Modifier) {
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    val expanded = stringResource(R.string.expanded)
    val collapsed = stringResource(R.string.collapsed)
    val body = row.message.body
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.animateContentSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = body.isNotEmpty(), role = Role.Button) { open = !open }
                    .semantics { if (body.isNotEmpty()) stateDescription = if (open) expanded else collapsed }
                    .padding(horizontal = Spacing.m, vertical = Spacing.s),
            ) {
                Icon(Icons.Outlined.AutoAwesome, contentDescription = null)
                Column(Modifier.weight(1f)) {
                    Text(row.message.title, style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(R.string.from_aura), style = MaterialTheme.typography.bodySmall)
                }
                if (body.isNotEmpty()) Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null)
            }
            if (open && body.isNotEmpty()) {
                MarkdownText(body, Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m))
            }
        }
    }
}

/** Steps the agent took, folded into one row that opens to show each of them. */
@Composable
private fun WorkRow(row: TranscriptRow.Work, modifier: Modifier) {
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    val expanded = stringResource(R.string.expanded)
    val collapsed = stringResource(R.string.collapsed)
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.animateContentSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) { open = !open }
                    .semantics { stateDescription = if (open) expanded else collapsed }
                    .padding(horizontal = Spacing.m, vertical = Spacing.s),
            ) {
                if (row.running) {
                    CircularProgressIndicator(Modifier.size(Spacing.m), strokeWidth = Spacing.xs / 2)
                } else {
                    Icon(Icons.Outlined.Handyman, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        pluralStringResource(R.plurals.steps, row.items.size, row.items.size),
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Text(
                        row.items.last().stepLabel(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null)
            }
            if (open) {
                Column(
                    Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    for (item in row.items) {
                        Text(item.stepLabel(), style = MaterialTheme.typography.bodyMedium)
                        item.stepDetail()?.let { detail ->
                            CodeBlock(if (detail.length > DETAIL_LIMIT) detail.take(DETAIL_LIMIT) + "\n…" else detail)
                        }
                    }
                }
            }
        }
    }
}
