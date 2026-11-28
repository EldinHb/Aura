package dev.aura.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import dev.aura.android.R
import dev.aura.android.protocol.TeamStatus
import dev.aura.android.ui.theme.Spacing

val TeamStatus.icon: ImageVector
    get() = when (this) {
        TeamStatus.WaitingOnYou -> Icons.Outlined.PanTool
        TeamStatus.Working -> Icons.Outlined.Sync
        TeamStatus.Failed -> Icons.Outlined.ErrorOutline
        TeamStatus.Done -> Icons.Outlined.CheckCircle
        TeamStatus.Idle -> Icons.Outlined.PauseCircle
    }

val TeamStatus.label: Int
    get() = when (this) {
        TeamStatus.WaitingOnYou -> R.string.team_waiting
        TeamStatus.Working -> R.string.team_working
        TeamStatus.Failed -> R.string.team_failed
        TeamStatus.Done -> R.string.team_done
        TeamStatus.Idle -> R.string.team_idle
    }

/** The status's container and its on-container color, an M3 pair, so the label reads on any wallpaper. */
@Composable
fun TeamStatus.colors(): Pair<Color, Color> = MaterialTheme.colorScheme.let { c ->
    when (this) {
        TeamStatus.WaitingOnYou -> c.tertiaryContainer to c.onTertiaryContainer
        TeamStatus.Working -> c.primaryContainer to c.onPrimaryContainer
        TeamStatus.Failed -> c.errorContainer to c.onErrorContainer
        TeamStatus.Done -> c.secondaryContainer to c.onSecondaryContainer
        TeamStatus.Idle -> c.surfaceContainerHighest to c.onSurfaceVariant
    }
}

/** The status as a chip: icon and word on the status's container. */
@Composable
fun StatusChip(status: TeamStatus, modifier: Modifier = Modifier) {
    val (container, content) = status.colors()
    Surface(color = container, contentColor = content, shape = MaterialTheme.shapes.small, modifier = modifier) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs / 2),
        ) {
            Icon(status.icon, contentDescription = null, modifier = Modifier.size(Spacing.m))
            Text(stringResource(status.label), style = MaterialTheme.typography.labelMedium)
        }
    }
}
