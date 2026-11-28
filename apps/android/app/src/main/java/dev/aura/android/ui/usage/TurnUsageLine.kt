package dev.aura.android.ui.usage

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import dev.aura.android.R
import dev.aura.android.protocol.TurnUsage
import dev.aura.android.protocol.formatCost
import dev.aura.android.protocol.formatPercent
import dev.aura.android.protocol.formatTokens
import dev.aura.android.protocol.line
import dev.aura.android.transcript.Row
import dev.aura.android.ui.theme.Spacing

/** The agent reply that ends each turn, by item id, with that turn's usage. */
fun turnEnds(rows: List<Row>, usage: Map<String, TurnUsage>): Map<String, TurnUsage> {
    if (usage.isEmpty()) return emptyMap()
    val last = HashMap<String, String>()
    for (row in rows) {
        if (row is Row.Agent) row.item.turnId?.let { last[it] = row.item.id }
    }
    return last.entries.mapNotNull { (turn, item) -> usage[turn]?.let { item to it } }.toMap()
}

/** A small dim line of what the turn spent, opening to the details. */
@Composable
fun TurnUsageLine(usage: TurnUsage, modifier: Modifier = Modifier) {
    var open by rememberSaveable(usage.turnId) { mutableStateOf(false) }
    val expanded = stringResource(R.string.expanded)
    val collapsed = stringResource(R.string.collapsed)
    val style = MaterialTheme.typography.labelSmall
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier
            .fillMaxWidth()
            .animateContentSize()
            .clickable(role = Role.Button) { open = !open }
            .semantics { stateDescription = if (open) expanded else collapsed }
            .padding(horizontal = Spacing.m, vertical = Spacing.xs),
    ) {
        Text(usage.line(), style = style, color = color)
        if (open) {
            Text(stringResource(R.string.usage_turn_input, formatTokens(usage.inputTokens)), style = style, color = color)
            Text(stringResource(R.string.usage_turn_output, formatTokens(usage.outputTokens)), style = style, color = color)
            Text(stringResource(R.string.usage_turn_cache_read, formatTokens(usage.cacheReadTokens)), style = style, color = color)
            Text(stringResource(R.string.usage_turn_cache_write, formatTokens(usage.cacheWriteTokens)), style = style, color = color)
            val used = usage.contextUsed
            if (used != null) {
                val window = usage.contextWindow
                Text(
                    if (window != null && window > 0) {
                        stringResource(R.string.usage_turn_context_of, formatTokens(used), formatTokens(window), formatPercent(used.toDouble() / window))
                    } else {
                        stringResource(R.string.usage_turn_context, formatTokens(used))
                    },
                    style = style,
                    color = color,
                )
            }
            val cost = usage.costUsd
            Text(
                when {
                    cost == null -> stringResource(R.string.usage_turn_no_price)
                    usage.estimated -> stringResource(R.string.usage_turn_cost_estimated, formatCost(cost))
                    else -> stringResource(R.string.usage_turn_cost, formatCost(cost))
                },
                style = style,
                color = color,
            )
            usage.model?.let { Text(it, style = style, color = color) }
        }
    }
}
