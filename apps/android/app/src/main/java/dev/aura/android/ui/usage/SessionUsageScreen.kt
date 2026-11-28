package dev.aura.android.ui.usage

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Update
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.theme.Spacing

/**
 * One session's usage: totals, the context over its turns, tokens per turn,
 * the split by model and, for a leader, its workers rolled up and one by one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionUsageScreen(serverId: String, sessionId: String, onBack: () -> Unit, onOpenSession: (sessionId: String) -> Unit) {
    val vm = appViewModel(key = "session-usage:$serverId:$sessionId") { SessionUsageViewModel(it, serverId, sessionId, includeWorkers = true) }
    val usage by vm.usage.collectAsStateWithLifecycle()
    val failed by vm.failed.collectAsStateWithLifecycle()
    val olderServer by vm.olderServer.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.usage_title))
                        usage?.title?.let {
                            Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back)) }
                },
                actions = {
                    IconButton(onClick = vm::load) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.refresh)) }
                },
            )
        },
    ) { padding ->
        val u = usage
        if (u == null && olderServer) {
            EmptyState(Icons.Outlined.Update, stringResource(R.string.older_server_title), stringResource(R.string.older_server_body), Modifier.padding(padding))
            return@Scaffold
        }
        if (u == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                val error = failed
                if (error == null) CircularProgressIndicator() else Text(stringResource(R.string.load_failed, error), modifier = Modifier.padding(Spacing.m))
            }
            return@Scaffold
        }
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = Spacing.contentMaxWidth).fillMaxWidth().padding(Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                val hasWorkers = u.workers.isNotEmpty()
                if (hasWorkers) SectionTitle(stringResource(R.string.usage_with_workers))
                TotalsCard(u.allTotals)
                if (hasWorkers) {
                    SectionTitle(stringResource(R.string.usage_own))
                    TotalsCard(u.totals)
                }
                if (u.turns.isNotEmpty()) {
                    SectionTitle(stringResource(R.string.usage_context))
                    val window = u.turns.lastOrNull { it.contextWindow != null }?.contextWindow
                    LineChart(
                        values = u.turns.map { it.contextUsed?.toDouble() },
                        ceiling = window?.toDouble(),
                        description = stringResource(R.string.usage_context),
                    )
                    SectionTitle(stringResource(R.string.usage_per_turn))
                    BarChart(
                        values = u.turns.map { (it.inputTokens + it.outputTokens + it.cacheReadTokens + it.cacheWriteTokens).toDouble() },
                        first = stringResource(R.string.usage_first_turn),
                        last = stringResource(R.string.usage_last_turn, u.turns.size),
                        description = stringResource(R.string.usage_per_turn),
                    )
                }
                SectionTitle(stringResource(R.string.usage_by_model))
                GroupList(u.models, u.allTotals)
                if (hasWorkers) {
                    SectionTitle(stringResource(R.string.usage_workers))
                    GroupList(u.workers, u.allTotals) { onOpenSession(it.key) }
                }
            }
        }
    }
}
