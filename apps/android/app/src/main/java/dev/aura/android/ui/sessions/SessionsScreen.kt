package dev.aura.android.ui.sessions

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.GppBad
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.net.Fingerprint
import dev.aura.android.protocol.LeaderRow
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.state
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.NewWorkspaceDialog
import dev.aura.android.ui.components.SessionStateIcon
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.components.color
import dev.aura.android.ui.components.describe
import dev.aura.android.ui.components.icon
import dev.aura.android.ui.components.label
import dev.aura.android.ui.theme.Spacing
import dev.aura.android.ui.theme.codeSmall

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    serverId: String,
    onBack: () -> Unit,
    onOpen: (sessionId: String) -> Unit,
    onNew: () -> Unit,
    onPairAgain: () -> Unit,
) {
    val vm = appViewModel(key = "sessions:$serverId") { SessionsViewModel(it, serverId) }
    val name by vm.serverName.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    val list by vm.list.collectAsStateWithLifecycle()
    val folded by vm.folded.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(SessionsTab.Sessions) }
    var newWorkspace by rememberSaveable { mutableStateOf(false) }
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val online = state is ConnectionState.Online

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = {
                    Column {
                        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(state.describe(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (online) {
                        IconButton(onClick = { newWorkspace = true }) {
                            Icon(Icons.Outlined.CreateNewFolder, contentDescription = stringResource(R.string.new_workspace))
                        }
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            if (online) {
                ExtendedFloatingActionButton(
                    onClick = onNew,
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    text = { Text(stringResource(R.string.new_session)) },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
        ) {
            val current = list
            val problem = state.takeUnless { it is ConnectionState.Online }
            when {
                problem != null && current == null -> ConnectionProblem(problem, onRetry = vm::retry, onPairAgain = onPairAgain)
                current == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> Column(Modifier.fillMaxSize()) {
                    SessionsTabs(tab, current, onSelect = { tab = it })
                    if (problem != null) ConnectionBanner(problem, onRetry = vm::retry, onPairAgain = onPairAgain)
                    AnimatedContent(
                        targetState = tab,
                        transitionSpec = { fadeIn(tween(TAB_FADE_MS)) togetherWith fadeOut(tween(TAB_FADE_MS)) },
                        modifier = Modifier.fillMaxSize(),
                        label = "sessions-tab",
                    ) { shown ->
                        val bottom = PaddingValues(bottom = padding.calculateBottomPadding() + Spacing.xl * 3)
                        when (shown) {
                            SessionsTab.Sessions -> SessionsTabContent(current, folded, vm::toggle, { onOpen(it.id) }, bottom)
                            SessionsTab.Scheduled -> ScheduledTabContent(current, folded, vm::toggle, { onOpen(it.id) }, bottom)
                        }
                    }
                }
            }
        }
    }

    if (newWorkspace) {
        NewWorkspaceDialog(onCreate = { vm.createWorkspace(it); newWorkspace = false }, onDismiss = { newWorkspace = false })
    }
}

private const val TAB_FADE_MS = 150

@Composable
fun SessionRow(session: Session, onClick: () -> Unit, modifier: Modifier = Modifier, overline: String? = null) {
    val state = session.state
    ListItem(
        modifier = modifier.clickable(onClick = onClick),
        overlineContent = overline?.let { { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        leadingContent = { SessionStateIcon(state) },
        headlineContent = {
            Text(session.title.ifBlank { stringResource(R.string.untitled_session) }, maxLines = 2, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            val who = session.specialistName ?: session.agent ?: session.provider.replaceFirstChar { it.uppercase() }
            Text("$who · ${stringResource(state.label)}", maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        trailingContent = if (session.pendingCount > 0) {
            {
                Badge(containerColor = MaterialTheme.colorScheme.tertiary, contentColor = MaterialTheme.colorScheme.onTertiary) {
                    Text(
                        "${session.pendingCount}",
                        modifier = Modifier.padding(horizontal = Spacing.xs),
                    )
                }
            }
        } else {
            null
        },
    )
}

/**
 * A leader's row: its state for its whole tree, its title, where it works and
 * who works under it. Its workers have no rows of their own; they are tabs in
 * the session.
 */
@Composable
fun LeaderRowItem(row: LeaderRow, context: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val session = row.session
    val pending = session.pendingCount + row.workers.sumOf { it.pendingCount }
    ListItem(
        modifier = modifier.clickable(onClick = onClick),
        overlineContent = when {
            session.featureOwner -> ({ Text(stringResource(R.string.feature_owner)) })
            session.orchestrator -> ({ Text(stringResource(R.string.orchestrator)) })
            else -> null
        },
        leadingContent = {
            Icon(row.rollup.icon, contentDescription = stringResource(row.rollup.label), tint = row.rollup.color())
        },
        headlineContent = {
            Text(session.title.ifBlank { stringResource(R.string.untitled_session) }, maxLines = 2, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            val who = session.agent ?: session.provider.replaceFirstChar { it.uppercase() }
            val parts = listOfNotNull(
                context.takeIf { it.isNotBlank() },
                who,
                row.workers.size.takeIf { it > 0 }?.let { n ->
                    val workers = pluralStringResource(if (session.featureOwner) R.plurals.team_count else R.plurals.worker_count, n, n)
                    if (row.workersWaiting > 0) stringResource(R.string.workers_need_you, workers, row.workersWaiting) else workers
                },
            )
            Text(parts.joinToString(" · "), maxLines = 2, overflow = TextOverflow.Ellipsis)
        },
        trailingContent = if (pending > 0) {
            {
                Badge(containerColor = MaterialTheme.colorScheme.tertiary, contentColor = MaterialTheme.colorScheme.onTertiary) {
                    Text("$pending", modifier = Modifier.padding(horizontal = Spacing.xs))
                }
            }
        } else {
            null
        },
    )
}

/** Why the server cannot be reached, filling the screen, with what the user can do. */
@Composable
fun ConnectionProblem(state: ConnectionState, onRetry: () -> Unit, onPairAgain: () -> Unit) {
    when (state) {
        is ConnectionState.CertificateMismatch -> EmptyState(
            icon = Icons.Outlined.GppBad,
            title = stringResource(R.string.cert_mismatch_title),
            body = stringResource(R.string.cert_mismatch_body, Fingerprint.grouped(state.expected), Fingerprint.grouped(state.actual)),
            action = { TextButton(onClick = onPairAgain) { Text(stringResource(R.string.pair_again)) } },
        )
        is ConnectionState.Revoked -> EmptyState(
            icon = Icons.Outlined.GppBad,
            title = stringResource(R.string.revoked_title),
            body = stringResource(R.string.revoked_body, state.reason),
            action = { TextButton(onClick = onPairAgain) { Text(stringResource(R.string.pair_again)) } },
        )
        else -> EmptyState(
            icon = Icons.Outlined.CloudOff,
            title = stringResource(R.string.offline_title),
            body = state.describe(),
            action = if (state is ConnectionState.Connecting) null else ({ TextButton(onClick = onRetry) { Text(stringResource(R.string.retry_now)) } }),
        )
    }
}

/** The same, as a card above a list that still shows what was loaded before. */
@Composable
fun ConnectionBanner(state: ConnectionState, onRetry: () -> Unit, onPairAgain: () -> Unit) {
    val serious = state is ConnectionState.CertificateMismatch || state is ConnectionState.Revoked
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (serious) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        ),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(
                when (state) {
                    is ConnectionState.CertificateMismatch -> stringResource(R.string.cert_mismatch_title)
                    is ConnectionState.Revoked -> stringResource(R.string.revoked_title)
                    else -> state.describe()
                },
                style = MaterialTheme.typography.titleSmall,
            )
            if (state is ConnectionState.CertificateMismatch) {
                Text(stringResource(R.string.cert_mismatch_short), style = MaterialTheme.typography.bodyMedium)
                Text(Fingerprint.grouped(state.actual), style = MaterialTheme.typography.codeSmall)
            }
            Row(Modifier.align(Alignment.End)) {
                if (serious) {
                    TextButton(onClick = onPairAgain) { Text(stringResource(R.string.pair_again)) }
                } else if (state !is ConnectionState.Connecting) {
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.retry_now)) }
                }
            }
        }
    }
}
