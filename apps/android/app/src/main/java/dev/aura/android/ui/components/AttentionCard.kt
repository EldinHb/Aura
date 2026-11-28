package dev.aura.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import dev.aura.android.ui.theme.Spacing

/**
 * A card for something the user is asked: a decision, an approval, a
 * question. It sits on a surface container with on-surface text, so every
 * control inside (radio buttons, text fields, text buttons) keeps the colors
 * it was made for and reads at full contrast with any wallpaper colors, light
 * or dark. What still waits on the user is set apart by a tertiary outline
 * and icon, not by tinting the text's background.
 */
@Composable
fun AttentionCard(
    open: Boolean,
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    label: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    OutlinedCard(
        colors = CardDefaults.outlinedCardColors(
            containerColor = if (open) colors.surfaceContainerHigh else colors.surfaceContainer,
            contentColor = colors.onSurface,
        ),
        border = if (open) BorderStroke(CardDefaults.outlinedCardBorder().width, colors.tertiary) else CardDefaults.outlinedCardBorder(),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(icon, contentDescription = null, tint = if (open) colors.tertiary else colors.onSurfaceVariant)
                Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f, fill = false))
                label?.invoke()
            }
            content()
        }
    }
}

/** A short label on its own container, as M3 pairs them: [container] with [onContainer] text. */
@Composable
fun Tag(text: String, container: Color, onContainer: Color, modifier: Modifier = Modifier) {
    Surface(color = container, contentColor = onContainer, shape = MaterialTheme.shapes.small, modifier = modifier) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs / 2))
    }
}
