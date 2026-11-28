package dev.aura.android.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import dev.aura.android.R
import dev.aura.android.protocol.Workspace
import dev.aura.android.ui.theme.Spacing

/** Workspace names are 1 to 40 characters on the server. */
const val WORKSPACE_NAME_MAX = 40

/** Asks for a new workspace's name. */
@Composable
fun NewWorkspaceDialog(onCreate: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Outlined.SpaceDashboard, contentDescription = null) },
        title = { Text(stringResource(R.string.new_workspace)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(WORKSPACE_NAME_MAX) },
                singleLine = true,
                label = { Text(stringResource(R.string.workspace_name)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = true, keyboardType = KeyboardType.Text),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onCreate(name.trim()) }) { Text(stringResource(R.string.create)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Picks the workspace to move a session (and its workers) to, or starts a new one. */
@Composable
fun MoveToWorkspaceDialog(
    workspaces: List<Workspace>,
    current: String,
    onMove: (String) -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    var picked by rememberSaveable { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Outlined.SpaceDashboard, contentDescription = null) },
        title = { Text(stringResource(R.string.move_to_workspace)) },
        text = {
            Column(Modifier.selectableGroup().verticalScroll(rememberScrollState())) {
                Text(stringResource(R.string.move_takes_workers), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = Spacing.s))
                for (w in workspaces) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = picked == w.id, role = Role.RadioButton) { picked = w.id }
                            .padding(vertical = Spacing.s),
                    ) {
                        RadioButton(selected = picked == w.id, onClick = null)
                        Text(w.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = Spacing.m))
                    }
                }
                TextButton(onClick = onNew) { Text(stringResource(R.string.new_workspace)) }
            }
        },
        confirmButton = { TextButton(enabled = picked != current, onClick = { onMove(picked) }) { Text(stringResource(R.string.move)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
