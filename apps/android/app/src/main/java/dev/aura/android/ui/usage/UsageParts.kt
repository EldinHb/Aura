package dev.aura.android.ui.usage

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.protocol.UsageGroup
import dev.aura.android.protocol.UsageTotals
import dev.aura.android.protocol.formatCost
import dev.aura.android.protocol.formatPercent
import dev.aura.android.protocol.formatTokens
import dev.aura.android.ui.theme.Spacing

/** Cost first (or tokens when none is known), then the tokens by kind, turns and what is estimated. */
@Composable
fun TotalsCard(totals: UsageTotals, modifier: Modifier = Modifier) {
    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            val priced = totals.turns > totals.unpricedTurns
            Text(
                if (priced) formatCost(totals.costUsd) else stringResource(R.string.usage_tokens, formatTokens(totals.tokens)),
                style = MaterialTheme.typography.headlineMedium,
            )
            Text(
                stringResource(
                    R.string.usage_breakdown,
                    formatTokens(totals.inputTokens),
                    formatTokens(totals.outputTokens),
                    formatTokens(totals.cacheReadTokens),
                    formatTokens(totals.cacheWriteTokens),
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            val extra = buildList {
                add(pluralStringResource(R.plurals.usage_turns, totals.turns, totals.turns))
                totals.cacheHitRate?.let { add(stringResource(R.string.usage_cache_hit, formatPercent(it))) }
                if (totals.estimatedCostUsd > 0) add(stringResource(R.string.usage_estimated_part, formatCost(totals.estimatedCostUsd)))
                if (totals.unpricedTurns > 0) add(pluralStringResource(R.plurals.usage_unpriced, totals.unpricedTurns, totals.unpricedTurns))
            }
            Text(extra.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = Spacing.s))
}

/** A ranked list of groups: label, cost (or tokens) and a share bar of the period's total. */
@Composable
fun GroupList(groups: List<UsageGroup>, total: UsageTotals, onOpen: ((UsageGroup) -> Unit)? = null) {
    if (groups.isEmpty()) {
        Text(stringResource(R.string.usage_none), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    Column {
        groups.forEachIndexed { i, g ->
            if (i > 0) HorizontalDivider()
            Row(
                Modifier
                    .fillMaxWidth()
                    .let { m -> if (onOpen != null && g.key.isNotEmpty()) m.clickable { onOpen(g) } else m }
                    .padding(vertical = Spacing.s),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(g.label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        stringResource(R.string.usage_group_detail, formatTokens(g.totals.tokens), pluralStringResource(R.plurals.usage_turns, g.totals.turns, g.totals.turns)),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(if (g.totals.costUsd > 0) formatCost(g.totals.costUsd) else "—", style = MaterialTheme.typography.bodyLarge)
                    share(g.totals, total)?.let {
                        Text(formatPercent(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** [part]'s share of [whole]: by cost when both have one, else by tokens. */
fun share(part: UsageTotals, whole: UsageTotals): Double? = when {
    whole.costUsd > 0 && part.costUsd > 0 -> part.costUsd / whole.costUsd
    whole.tokens > 0 -> part.tokens.toDouble() / whole.tokens
    else -> null
}
