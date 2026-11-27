package dev.aura.android.ui.sessions

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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.net.Fingerprint
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.state
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.SessionStateIcon
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.components.describe
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
    val groups by vm.groups.collectAsStateWithLifecycle()
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
            val list = groups
            val problem = state.takeUnless { it is ConnectionState.Online }
            when {
                problem != null && list == null -> ConnectionProblem(problem, onRetry = vm::retry, onPairAgain = onPairAgain)
                list == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                list.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.Inbox,
                    title = stringResource(R.string.sessions_empty_title),
                    body = stringResource(R.string.sessions_empty_body),
                )
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = padding.calculateBottomPadding() + Spacing.xl * 3),
                ) {
                    if (problem != null) {
                        item(key = "problem") { ConnectionBanner(problem, onRetry = vm::retry, onPairAgain = onPairAgain) }
                    }
                    for (group in list) {
                        stickyHeader(key = "project:${group.path}") {
                            ListItem(
                                leadingContent = { Icon(Icons.Outlined.Folder, contentDescription = null) },
                                headlineContent = { Text(group.name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary) },
                                supportingContent = { Text(group.path, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall) },
                            )
                        }
                        items(group.sessions, key = { it.id }) { session ->
                            SessionRow(session, onClick = { onOpen(session.id) }, modifier = Modifier.animateItem())
                        }
                    }
                }
            }
        }
    }
}

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
