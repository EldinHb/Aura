package dev.aura.android.ui.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.teamStatus
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.MarkdownText
import dev.aura.android.ui.components.StatusChip
import dev.aura.android.ui.components.Tag
import dev.aura.android.ui.theme.Spacing

/**
 * A leader's team at a glance: for a feature owner its feature first (status,
 * goal, open questions, checkpoints, decisions), then every worker with what
 * it is, what runs it, how it is doing and the last thing it said. A worker
 * opens its own tab.
 */
@Composable
fun TeamView(
    workers: List<Session>,
    feature: Feature?,
    replies: Map<String, String>,
    onOpen: (String) -> Unit,
    contentPadding: PaddingValues,
) {
    if (workers.isEmpty() && feature == null) {
        EmptyState(Icons.Outlined.Groups, stringResource(R.string.tab_team), stringResource(R.string.team_empty))
        return
    }
    val roles = feature?.team?.associateBy { it.workerId }.orEmpty()
    LazyColumn(contentPadding = contentPadding, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        feature?.let { f -> item(key = "feature") { FeatureSummary(f, Modifier.padding(bottom = Spacing.s)) } }
        if (workers.isNotEmpty()) {
            item(key = "members") {
                Text(
                    stringResource(R.string.team_members),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s),
                )
            }
        }
        items(workers, key = { it.id }) { w ->
            val member = roles[w.id]
            val role = member?.role?.ifBlank { null } ?: w.specialistName
            val runs = listOfNotNull(w.agent ?: w.provider.replaceFirstChar { it.uppercase() }, w.model, w.effort).joinToString(" · ")
            val reply = replies[w.id]?.lineSequence()?.map { it.trim().trimStart('#', '*', '-', '>', ' ') }?.firstOrNull { it.isNotBlank() }
            ListItem(
                modifier = Modifier.animateItem().clickable { onOpen(w.id) },
                overlineContent = role?.let { { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
                headlineContent = { Text(member?.name?.ifBlank { null } ?: w.title.ifBlank { stringResource(R.string.untitled_session) }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                supportingContent = {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        Text(runs, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        StatusChip(w.teamStatus)
                        (reply ?: w.lastError)?.let { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium) }
                    }
                },
            )
        }
    }
}

/** What the desktop shows for a feature: its status, goal, open questions, checkpoints and decisions. */
@Composable
private fun FeatureSummary(f: Feature, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Card(
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainerHigh, contentColor = colors.onSurface),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(Icons.Outlined.Flag, contentDescription = null, tint = colors.tertiary)
                Text(stringResource(R.string.feature), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                val (status, pair) = when (f.status) {
                    "planning" -> R.string.feature_status_planning to (colors.secondaryContainer to colors.onSecondaryContainer)
                    "waiting_on_user" -> R.string.feature_status_waiting to (colors.tertiaryContainer to colors.onTertiaryContainer)
                    "delivered" -> R.string.feature_status_delivered to (colors.primaryContainer to colors.onPrimaryContainer)
                    else -> R.string.feature_status_in_progress to (colors.primaryContainer to colors.onPrimaryContainer)
                }
                Tag(stringResource(status), pair.first, pair.second)
            }
            if (f.goal.isNotBlank()) MarkdownText(f.goal)
            val open = f.questions.filter { it.open }
            if (open.isNotEmpty()) {
                Heading(stringResource(R.string.feature_open_questions))
                open.forEach { Text("• ${it.question}", style = MaterialTheme.typography.bodyMedium) }
            }
            if (f.checkpoints.isNotEmpty()) {
                Heading(stringResource(R.string.feature_checkpoints))
                f.checkpoints.forEach { c ->
                    val state = when (c.approved) {
                        true -> R.string.checkpoint_approved
                        false -> R.string.checkpoint_changes
                        null -> R.string.checkpoint_open
                    }
                    val name = when (c.checkpoint) {
                        "after_design" -> R.string.checkpoint_after_design
                        "before_implementation" -> R.string.checkpoint_before_implementation
                        else -> R.string.checkpoint_before_delivery
                    }
                    Text("${stringResource(name)} · ${stringResource(state)}", style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (f.decisions.isNotEmpty()) {
                Heading(stringResource(R.string.feature_decisions))
                f.decisions.takeLast(DECISIONS_SHOWN).asReversed().forEach { d ->
                    val who = stringResource(if (d.decidedBy == "user") R.string.decided_by_user else R.string.decided_by_owner)
                    Column {
                        Text(d.decision, style = MaterialTheme.typography.bodyMedium)
                        if (d.rationale.isNotBlank()) {
                            Text("$who · ${d.rationale}", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            f.report?.let { r ->
                Heading(stringResource(R.string.feature_report))
                MarkdownText(listOf(r.what, r.howToTest, r.whereToTest).filter { it.isNotBlank() }.joinToString("\n\n"))
            }
        }
    }
}

/** The latest decisions the summary shows; the rest are in the owner's chat. */
private const val DECISIONS_SHOWN = 8

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Spacing.xs))
}
