package dev.aura.android.ui.changes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Update
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.diff.DiffFile
import dev.aura.android.diff.DiffLine
import dev.aura.android.diff.reference
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.Tag
import dev.aura.android.ui.theme.Spacing
import dev.aura.android.ui.theme.codeSmall

/**
 * What a session changed, as a unified diff per file: added and removed
 * lines on their containers with a +/− mark (never by colour alone),
 * scrolling sideways, each file folded open or shut. Tap a line, then "Ask
 * for changes": the composer gets `file:line`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangesScreen(serverId: String, sessionId: String, title: String, onBack: () -> Unit) {
    val vm = appViewModel(key = "changes:$serverId:$sessionId") { ChangesViewModel(it, serverId, sessionId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val folded = remember { mutableStateMapOf<String, Boolean>() }
    var picked by remember { mutableStateOf<Pair<DiffFile, DiffLine?>?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.changes))
                        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back)) } },
                actions = { IconButton(onClick = vm::load) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.refresh)) } },
            )
        },
        floatingActionButton = {
            picked?.let { (file, line) ->
                ExtendedFloatingActionButton(
                    onClick = {
                        vm.askForChanges(reference(file, line) + " ")
                        onBack()
                    },
                    icon = { Icon(Icons.Outlined.EditNote, contentDescription = null) },
                    text = { Text(stringResource(R.string.ask_for_changes)) },
                )
            }
        },
    ) { padding ->
        when (val s = state) {
            ChangesState.Loading -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is ChangesState.Failed -> EmptyState(
                Icons.Outlined.ErrorOutline,
                stringResource(R.string.changes_failed),
                s.message,
                Modifier.padding(padding),
            ) { TextButton(onClick = vm::load) { Text(stringResource(R.string.retry_now)) } }
            ChangesState.OlderServer -> EmptyState(
                Icons.Outlined.Update,
                stringResource(R.string.older_server_title),
                stringResource(R.string.older_server_body),
                Modifier.padding(padding),
            )
            is ChangesState.Loaded -> if (s.files.isEmpty()) {
                EmptyState(Icons.Outlined.Difference, stringResource(R.string.changes_none_title), stringResource(R.string.changes_none_body), Modifier.padding(padding))
            } else {
                LazyColumn(contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.xl * 3)) {
                    for (file in s.files) {
                        val open = folded[file.path] != true
                        item(key = "file:" + file.path) {
                            FileHeader(file, open, onToggle = { folded[file.path] = open }, onPick = { picked = file to null })
                        }
                        if (open && file.lines.isNotEmpty()) {
                            item(key = "lines:" + file.path) {
                                FileLines(file, picked?.takeIf { it.first == file }?.second, onPick = { line -> picked = file to line })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileHeader(file: DiffFile, open: Boolean, onToggle: () -> Unit, onPick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val state = stringResource(if (open) R.string.expanded else R.string.collapsed)
    ListItem(
        modifier = Modifier.clickable(role = Role.Button, onClick = onToggle).semantics { stateDescription = state },
        colors = ListItemDefaults.colors(containerColor = colors.surfaceContainer),
        headlineContent = { Text(file.path, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                when {
                    file.isNew -> Tag(stringResource(R.string.change_new), colors.primaryContainer, colors.onPrimaryContainer)
                    file.deleted -> Tag(stringResource(R.string.change_deleted), colors.errorContainer, colors.onErrorContainer)
                    file.oldPath != null -> Tag(stringResource(R.string.change_renamed, file.oldPath), colors.secondaryContainer, colors.onSecondaryContainer)
                }
                if (file.binary) {
                    Text(stringResource(R.string.change_binary))
                } else {
                    Text(stringResource(R.string.change_counts, file.added, file.removed))
                }
            }
        },
        trailingContent = {
            Row {
                IconButton(onClick = onPick) { Icon(Icons.Outlined.EditNote, contentDescription = stringResource(R.string.ask_about_file, file.path)) }
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.align(Alignment.CenterVertically))
            }
        },
    )
}

/** The file's lines, one block scrolling sideways together so they stay aligned. */
@Composable
private fun FileLines(file: DiffFile, picked: DiffLine?, onPick: (DiffLine) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val numbers = file.lines.maxOfOrNull { it.line ?: 0 }?.toString()?.length ?: 1
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = Spacing.xs)) {
        for (line in file.lines) {
            val (bg, fg, mark) = when (line.kind) {
                DiffLine.Kind.Added -> Triple(colors.primaryContainer, colors.onPrimaryContainer, "+")
                DiffLine.Kind.Removed -> Triple(colors.errorContainer, colors.onErrorContainer, "−")
                DiffLine.Kind.Hunk -> Triple(colors.surfaceContainerHighest, colors.onSurfaceVariant, "")
                DiffLine.Kind.Note -> Triple(Color.Transparent, colors.onSurfaceVariant, "")
                DiffLine.Kind.Context -> Triple(Color.Transparent, colors.onSurface, " ")
            }
            val selected = line === picked
            val description = when (line.kind) {
                DiffLine.Kind.Added -> stringResource(R.string.line_added, line.line ?: 0, line.text)
                DiffLine.Kind.Removed -> stringResource(R.string.line_removed, line.line ?: 0, line.text)
                else -> line.text
            }
            Row(
                Modifier
                    .widthIn(min = Spacing.contentMaxWidth)
                    .background(if (selected) colors.inversePrimary else bg)
                    .clickable(enabled = line.line != null) { onPick(line) }
                    .semantics { this.selected = selected; contentDescription = description }
                    .padding(horizontal = Spacing.s),
            ) {
                Text(
                    (line.line?.toString() ?: "").padStart(numbers),
                    style = MaterialTheme.typography.codeSmall,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.width(Spacing.l + Spacing.s * numbers / 2),
                )
                Text("$mark${line.text}", style = MaterialTheme.typography.codeSmall, color = if (selected) colors.onSurface else fg, softWrap = false)
            }
        }
    }
}
