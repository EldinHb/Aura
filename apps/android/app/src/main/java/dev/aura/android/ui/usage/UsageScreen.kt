package dev.aura.android.ui.usage

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.theme.Spacing
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** A server's usage over a period: totals, a bar per day, and the biggest sessions, features and models. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(serverId: String, onBack: () -> Unit, onOpenSession: (sessionId: String) -> Unit) {
    val vm = appViewModel(key = "usage:$serverId") { UsageViewModel(it, serverId) }
    val period by vm.period.collectAsStateWithLifecycle()
    val dashboard by vm.dashboard.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val olderServer by vm.olderServer.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.usage_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back)) }
                },
                actions = {
                    IconButton(onClick = vm::load) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.refresh)) }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = Spacing.contentMaxWidth).fillMaxWidth().padding(Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    val labels = mapOf(
                        UsagePeriod.Today to R.string.usage_today,
                        UsagePeriod.Week to R.string.usage_7_days,
                        UsagePeriod.Month to R.string.usage_30_days,
                    )
                    for (p in UsagePeriod.entries) {
                        FilterChip(selected = p == period, onClick = { vm.select(p) }, label = { Text(stringResource(labels.getValue(p))) })
                    }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                val d = dashboard
                if (d == null) {
                    if (olderServer) {
                        // Not EmptyState: this column scrolls already.
                        Text(stringResource(R.string.older_server_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.older_server_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!loading) return@Column
                    Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    return@Column
                }
                TotalsCard(d.days.totals)
                if (d.days.groups.size > 1) {
                    SectionTitle(stringResource(R.string.usage_per_day))
                    val byCost = d.days.totals.costUsd > 0
                    val fmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
                    fun day(key: String) = runCatching { LocalDate.parse(key).format(fmt) }.getOrDefault(key)
                    BarChart(
                        values = d.days.groups.map { if (byCost) it.totals.costUsd else it.totals.tokens.toDouble() },
                        first = day(d.days.groups.first().key),
                        last = day(d.days.groups.last().key),
                        description = stringResource(if (byCost) R.string.usage_chart_cost else R.string.usage_chart_tokens),
                    )
                }
                SectionTitle(stringResource(R.string.usage_top_sessions))
                GroupList(d.sessions.groups, d.sessions.totals) { onOpenSession(it.key) }
                SectionTitle(stringResource(R.string.usage_top_features))
                GroupList(d.features.groups, d.features.totals) { g -> onOpenSession(g.key) }
                SectionTitle(stringResource(R.string.usage_top_models))
                GroupList(d.models.groups, d.models.totals)
                Text(
                    stringResource(R.string.usage_estimates_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
