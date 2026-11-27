package dev.aura.android.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import dev.aura.android.R
import dev.aura.android.protocol.SessionState

val SessionState.icon: ImageVector
    get() = when (this) {
        SessionState.Waiting -> Icons.Outlined.PanTool
        SessionState.Running -> Icons.Outlined.Sync
        SessionState.Failed -> Icons.Outlined.ErrorOutline
        SessionState.Done -> Icons.Outlined.CheckCircle
        SessionState.Idle -> Icons.Outlined.PauseCircle
    }

val SessionState.label: Int
    get() = when (this) {
        SessionState.Waiting -> R.string.state_waiting
        SessionState.Running -> R.string.state_running
        SessionState.Failed -> R.string.state_failed
        SessionState.Done -> R.string.state_done
        SessionState.Idle -> R.string.state_idle
    }

@Composable
fun SessionState.color(): Color = when (this) {
    SessionState.Waiting -> MaterialTheme.colorScheme.tertiary
    SessionState.Running -> MaterialTheme.colorScheme.primary
    SessionState.Failed -> MaterialTheme.colorScheme.error
    SessionState.Done, SessionState.Idle -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** The state's icon, in its color; the label is said to screen readers. */
@Composable
fun SessionStateIcon(state: SessionState, modifier: Modifier = Modifier) {
    Icon(state.icon, contentDescription = stringResource(state.label), tint = state.color(), modifier = modifier)
}
