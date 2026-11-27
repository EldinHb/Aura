package dev.aura.android.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.protocol.SessionState
import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.isStructured
import dev.aura.android.protocol.projectPath
import dev.aura.android.protocol.state
import dev.aura.android.transcript.Row as TranscriptRow
import dev.aura.android.transcript.rows
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.SheetAction
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.components.describe
import dev.aura.android.ui.components.label
import dev.aura.android.ui.theme.Spacing

/** The most lines the composer grows to before it scrolls. */
private const val COMPOSER_MAX_LINES = 6

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(serverId: String, sessionId: String, onBack: () -> Unit) {
    val vm = appViewModel(key = "session:$serverId:$sessionId") { SessionViewModel(it, serverId, sessionId) }
    val session by vm.session.collectAsStateWithLifecycle()
    val transcript by vm.transcript.collectAsStateWithLifecycle()
    val connection by vm.connectionState.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()
    val online = connection is ConnectionState.Online
    val running = session?.status == "running" || transcript?.turnRunning == true
    var actions by remember { mutableStateOf(false) }
    var confirmStop by remember { mutableStateOf(false) }

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            session?.title?.ifBlank { null } ?: stringResource(R.string.untitled_session),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        session?.let { s ->
                            Text(
                                "${folderName(s.projectPath)} · ${stringResource(s.state.label)}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (running) {
                        IconButton(onClick = vm::interrupt, enabled = online) {
                            Icon(Icons.Outlined.StopCircle, contentDescription = stringResource(R.string.interrupt))
                        }
                    }
                    IconButton(onClick = { actions = true }) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.session_actions))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        bottomBar = {
            if (session?.isStructured != false) {
                Composer(enabled = online && !sending, sending = sending, onSend = vm::send)
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val t = transcript
        val s = session
        when {
            s != null && !s.isStructured -> EmptyState(
                icon = Icons.Outlined.Terminal,
                title = stringResource(R.string.terminal_session_title),
                body = stringResource(R.string.terminal_session_body),
                modifier = Modifier.padding(padding),
            )
            t == null && !online -> EmptyState(
                icon = Icons.Outlined.Cancel,
                title = stringResource(R.string.offline_title),
                body = connection.describe(),
                modifier = Modifier.padding(padding),
            )
            t == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else -> {
                val rows = remember(t) { rows(t.visibleItems) }
                val list = rememberLazyListState()
                val total = rows.size + t.approvals.size + t.inputs.size
                val lastLength = rows.lastOrNull()?.let { r -> (r as? TranscriptRow.Agent)?.item?.text?.length } ?: 0
                // Follow the conversation while the user is at its end.
                LaunchedEffect(total, lastLength) {
                    val atEnd = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= list.layoutInfo.totalItemsCount - 3 } ?: true
                    if (atEnd && total > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1)
                }
                LazyColumn(
                    state = list,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(top = padding.calculateTopPadding() + Spacing.s, bottom = padding.calculateBottomPadding() + Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.m),
                ) {
                    if (rows.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                stringResource(R.string.transcript_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = Spacing.m),
                            )
                        }
                    }
                    items(rows, key = { it.key }) { row -> TranscriptRowView(row, Modifier.animateItem()) }
                    t.lastError?.let { error ->
                        item(key = "turn-error") {
                            Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.m))
                        }
                    }
                    if (running) {
                        item(key = "working") {
                            LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = Spacing.m))
                        }
                    }
                    items(t.approvals, key = { "approval:" + it.id }) { approval ->
                        ApprovalCard(approval, enabled = online, onRespond = { vm.respond(approval, it) }, modifier = Modifier.animateItem())
                    }
                    items(t.inputs, key = { "input:" + it.id }) { request ->
                        QuestionsCard(
                            request,
                            enabled = online,
                            onAnswer = { vm.answer(request, it) },
                            onDismiss = { vm.answer(request, emptyMap(), declined = true) },
                            modifier = Modifier.animateItem(),
                        )
                    }
                    if (s?.state == SessionState.Failed && s.lastError != null && t.lastError == null) {
                        item(key = "session-error") {
                            Text(s.lastError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.m))
                        }
                    }
                }
            }
        }
    }

    if (actions) {
        ModalBottomSheet(onDismissRequest = { actions = false }) {
            SheetAction(Icons.Outlined.StopCircle, stringResource(R.string.interrupt)) { actions = false; vm.interrupt() }
            SheetAction(Icons.Outlined.Cancel, stringResource(R.string.stop_session)) { actions = false; confirmStop = true }
            Box(Modifier.navigationBarsPadding())
        }
    }
    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text(stringResource(R.string.stop_session_title)) },
            text = { Text(stringResource(R.string.stop_session_body)) },
            confirmButton = { TextButton(onClick = { confirmStop = false; vm.stop() }) { Text(stringResource(R.string.stop)) } },
            dismissButton = { TextButton(onClick = { confirmStop = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun Composer(enabled: Boolean, sending: Boolean, onSend: (String, () -> Unit) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                .padding(horizontal = Spacing.m, vertical = Spacing.s),
        ) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(stringResource(R.string.message_placeholder)) },
                maxLines = COMPOSER_MAX_LINES,
                shape = MaterialTheme.shapes.extraLarge,
                modifier = Modifier.weight(1f),
            )
            FilledIconButton(
                onClick = { onSend(text) { text = "" } },
                enabled = enabled && text.isNotBlank(),
                modifier = Modifier.padding(bottom = Spacing.xs),
            ) {
                if (sending) {
                    CircularProgressIndicator(Modifier.padding(Spacing.s))
                } else {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.send))
                }
            }
        }
    }
}
