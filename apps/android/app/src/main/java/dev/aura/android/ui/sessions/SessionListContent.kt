package dev.aura.android.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.protocol.Category
import dev.aura.android.protocol.LeaderRow
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.SessionList
import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.projectPath
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.color
import dev.aura.android.ui.components.icon
import dev.aura.android.ui.components.label
import dev.aura.android.ui.theme.Spacing

/** The two tabs of the session list, as on the desktop. */
enum class SessionsTab { Sessions, Scheduled }

@Composable
fun SessionsTabs(selected: SessionsTab, list: SessionList, onSelect: (SessionsTab) -> Unit) {
    val needsYou = list.workspaces.sumOf { it.needsYou }
    val scheduledNeedsYou = list.scheduled.sumOf { t -> t.runs.count { it.rollup == Category.NeedsYou } }
    PrimaryTabRow(selectedTabIndex = selected.ordinal) {
        TabWithCount(selected == SessionsTab.Sessions, stringResource(R.string.tab_sessions), needsYou) { onSelect(SessionsTab.Sessions) }
        TabWithCount(selected == SessionsTab.Scheduled, stringResource(R.string.tab_scheduled), scheduledNeedsYou) { onSelect(SessionsTab.Scheduled) }
    }
}

@Composable
private fun TabWithCount(selected: Boolean, label: String, needsYou: Int, onClick: () -> Unit) {
    Tab(
        selected = selected,
        onClick = onClick,
        text = {
            BadgedBox(badge = { if (needsYou > 0) Badge { Text("$needsYou") } }) { Text(label) }
        },
    )
}

/** Workspaces, each folded open or shut, with their leaders by status. */
@Composable
fun SessionsTabContent(
    list: SessionList,
    folded: Set<String>,
    onToggle: (String) -> Unit,
    onOpen: (Session) -> Unit,
    contentPadding: PaddingValues,
) {
    if (list.workspaces.isEmpty()) {
        EmptyState(Icons.Outlined.Inbox, stringResource(R.string.sessions_empty_title), stringResource(R.string.sessions_empty_body))
        return
    }
    val headed = list.workspaces.size > 1
    LazyColumn(contentPadding = contentPadding) {
        for (group in list.workspaces) {
            val wsKey = "ws:" + (group.workspace?.id ?: "")
            val wsOpen = !headed || wsKey !in folded
            if (headed) {
                foldHeader(
                    key = wsKey,
                    open = wsOpen,
                    icon = Icons.Outlined.SpaceDashboard,
                    title = { group.workspace?.name.orEmpty() },
                    emphasis = true,
                    onToggle = onToggle,
                ) {
                    val sessions = pluralStringResource(R.plurals.session_count, group.count, group.count)
                    if (group.needsYou > 0) stringResource(R.string.workspace_summary_needs_you, sessions, group.needsYou) else sessions
                }
            }
            if (!wsOpen) continue
            for (section in group.sections) {
                val key = "$wsKey:${section.category}"
                val open = key !in folded
                foldHeader(
                    key = key,
                    open = open,
                    icon = section.category.icon,
                    iconTint = { section.category.color() },
                    title = { stringResource(section.category.label) },
                    onToggle = onToggle,
                ) { "${section.rows.size}" }
                if (open) leaderRows(section.rows, onOpen) { it.session.projectPath.let(::folderName) }
            }
        }
    }
}

/** A section per scheduled task, its runs newest first. */
@Composable
fun ScheduledTabContent(
    list: SessionList,
    folded: Set<String>,
    onToggle: (String) -> Unit,
    onOpen: (Session) -> Unit,
    contentPadding: PaddingValues,
) {
    if (list.scheduled.isEmpty()) {
        EmptyState(Icons.Outlined.Schedule, stringResource(R.string.scheduled_empty_title), stringResource(R.string.scheduled_empty_body))
        return
    }
    LazyColumn(contentPadding = contentPadding) {
        for (task in list.scheduled) {
            val key = "task:${task.taskId}"
            val open = key !in folded
            foldHeader(key = key, open = open, icon = Icons.Outlined.Schedule, title = { task.name }, onToggle = onToggle) {
                pluralStringResource(R.plurals.run_count, task.runs.size, task.runs.size)
            }
            if (open) leaderRows(task.runs, onOpen) { formatStarted(it.session.createdAt) }
        }
    }
}

/** "2026-11-28T09:30:12Z" as "2026-11-28 09:30", which reads in any locale. */
private fun formatStarted(at: String): String = at.take(16).replace('T', ' ')

private fun LazyListScope.foldHeader(
    key: String,
    open: Boolean,
    icon: ImageVector,
    title: @Composable () -> String,
    onToggle: (String) -> Unit,
    emphasis: Boolean = false,
    iconTint: (@Composable () -> Color)? = null,
    summary: @Composable () -> String,
) {
    item(key = "header:$key", contentType = "header") {
        val stateText = stringResource(if (open) R.string.expanded else R.string.collapsed)
        ListItem(
            modifier = Modifier
                .animateItem()
                .clickable(role = Role.Button) { onToggle(key) }
                .semantics { stateDescription = stateText },
            colors = if (emphasis) ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer) else ListItemDefaults.colors(),
            leadingContent = { Icon(icon, contentDescription = null, tint = iconTint?.invoke() ?: MaterialTheme.colorScheme.onSurfaceVariant) },
            headlineContent = {
                Text(
                    title(),
                    style = if (emphasis) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            supportingContent = if (emphasis) ({ Text(summary()) }) else null,
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    if (!emphasis) Text(summary(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null)
                }
            },
        )
    }
}

private fun LazyListScope.leaderRows(rows: List<LeaderRow>, onOpen: (Session) -> Unit, context: @Composable (LeaderRow) -> String) {
    items(rows, key = { it.session.id }, contentType = { "leader" }) { row ->
        LeaderRowItem(row, context(row), onClick = { onOpen(row.session) }, modifier = Modifier.animateItem())
    }
}
