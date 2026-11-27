package dev.aura.android.ui.servers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.data.SavedServer
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.SheetAction
import dev.aura.android.ui.components.color
import dev.aura.android.ui.components.describe
import dev.aura.android.ui.components.needsPairing
import dev.aura.android.ui.theme.Spacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServersScreen(
    onOpen: (serverId: String) -> Unit,
    onAdd: () -> Unit,
) {
    val vm = appViewModel { ServersViewModel(it) }
    val servers by vm.servers.collectAsStateWithLifecycle()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    var actionsFor by remember { mutableStateOf<ServerUi?>(null) }
    var renaming by remember { mutableStateOf<SavedServer?>(null) }
    var removing by remember { mutableStateOf<SavedServer?>(null) }

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(title = { Text(stringResource(R.string.servers_title)) }, scrollBehavior = scrollBehavior)
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onAdd,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text(stringResource(R.string.add_server)) },
            )
        },
    ) { padding ->
        val list = servers
        when {
            list == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            list.isEmpty() -> EmptyState(
                icon = Icons.Outlined.QrCodeScanner,
                title = stringResource(R.string.servers_empty_title),
                body = stringResource(R.string.servers_empty_body),
                modifier = Modifier.padding(padding),
            )
            else -> LazyColumn(
                contentPadding = PaddingValues(
                    top = padding.calculateTopPadding(),
                    bottom = padding.calculateBottomPadding() + Spacing.xl * 3,
                ),
            ) {
                items(list, key = { it.server.id }) { ui ->
                    ListItem(
                        modifier = Modifier.animateItem().clickable { onOpen(ui.server.id) },
                        leadingContent = { Icon(Icons.Outlined.Dns, contentDescription = null, tint = ui.state.color()) },
                        headlineContent = { Text(ui.server.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = {
                            Text(
                                "${ui.server.address} · ${ui.state.describe()}",
                                color = if (ui.state.needsPairing) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        trailingContent = {
                            IconButton(onClick = { actionsFor = ui }) {
                                Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.server_actions, ui.server.name))
                            }
                        },
                    )
                }
            }
        }
    }

    actionsFor?.let { ui ->
        val sheet = rememberModalBottomSheetState()
        ModalBottomSheet(onDismissRequest = { actionsFor = null }, sheetState = sheet) {
            Text(
                ui.server.name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s),
            )
            if (ui.state.needsPairing) {
                SheetAction(Icons.Outlined.LinkOff, stringResource(R.string.pair_again)) { actionsFor = null; onAdd() }
            } else {
                SheetAction(Icons.Outlined.Refresh, stringResource(R.string.reconnect)) { actionsFor = null; vm.reconnect(ui.server.id) }
            }
            SheetAction(Icons.Outlined.Edit, stringResource(R.string.rename)) { actionsFor = null; renaming = ui.server }
            SheetAction(Icons.Outlined.Delete, stringResource(R.string.remove)) { actionsFor = null; removing = ui.server }
            Box(Modifier.navigationBarsPadding())
        }
    }

    renaming?.let { server ->
        var name by rememberSaveable { mutableStateOf(server.name) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text(stringResource(R.string.rename_server)) },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, label = { Text(stringResource(R.string.name)) })
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = { vm.rename(server.id, name); renaming = null }) { Text(stringResource(R.string.save)) }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }

    removing?.let { server ->
        AlertDialog(
            onDismissRequest = { removing = null },
            icon = { Icon(Icons.Outlined.Delete, contentDescription = null) },
            title = { Text(stringResource(R.string.remove_server_title, server.name)) },
            text = { Text(stringResource(R.string.remove_server_body)) },
            confirmButton = { TextButton(onClick = { vm.remove(server.id); removing = null }) { Text(stringResource(R.string.remove)) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
