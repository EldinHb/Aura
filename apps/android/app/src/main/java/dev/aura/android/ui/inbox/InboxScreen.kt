package dev.aura.android.ui.inbox

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
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
import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.projectPath
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.sessions.SessionRow
import dev.aura.android.ui.theme.Spacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(onOpen: (serverId: String, sessionId: String) -> Unit) {
    val vm = appViewModel { InboxViewModel(it) }
    val inbox by vm.inbox.collectAsStateWithLifecycle()
    val answering by vm.answering.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = { LargeTopAppBar(title = { Text(stringResource(R.string.inbox_title)) }, scrollBehavior = scrollBehavior) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val current = inbox
        when {
            current == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            current.size == 0 -> EmptyState(
                icon = Icons.Outlined.DoneAll,
                title = stringResource(R.string.inbox_empty_title),
                body = stringResource(R.string.inbox_empty_body),
                modifier = Modifier.padding(padding),
            )
            else -> LazyColumn(contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.m)) {
                if (current.questions.isNotEmpty()) {
                    item(key = "questions-header") { SectionHeader(stringResource(R.string.inbox_questions)) }
                    items(current.questions, key = { it.key }) { q ->
                        FeatureQuestionCard(
                            q,
                            answering = q.key in answering,
                            onAnswer = { option, text -> vm.answer(q, option, text) },
                            onOpenOwner = { onOpen(q.serverId, q.feature.ownerId) },
                            modifier = Modifier.animateItem().padding(bottom = Spacing.s),
                        )
                    }
                }
                if (current.sessions.isNotEmpty()) {
                    item(key = "sessions-header") { SectionHeader(stringResource(R.string.inbox_sessions)) }
                    items(current.sessions, key = { it.serverId + ":" + it.session.id }) { w ->
                        SessionRow(
                            w.session,
                            onClick = { onOpen(w.serverId, w.session.id) },
                            overline = "${w.serverName} · ${folderName(w.session.projectPath)}",
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    ListItem(headlineContent = { Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary) })
}
