package dev.aura.android.ui.session

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.AuraApplication
import dev.aura.android.R
import dev.aura.android.net.ConnectionState
import dev.aura.android.notify.OpenSession
import dev.aura.android.protocol.Feature
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.SessionState
import dev.aura.android.protocol.TeamStatus
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.isStructured
import dev.aura.android.protocol.projectPath
import dev.aura.android.protocol.state
import dev.aura.android.protocol.teamStatus
import dev.aura.android.transcript.Row as TranscriptRow
import dev.aura.android.transcript.rows
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.DecisionCard
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.MarkdownText
import dev.aura.android.ui.components.MoveToWorkspaceDialog
import dev.aura.android.ui.components.NewWorkspaceDialog
import dev.aura.android.ui.components.ProseKeyboard
import dev.aura.android.ui.components.SheetAction
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.components.color
import dev.aura.android.ui.components.describe
import dev.aura.android.ui.components.icon
import dev.aura.android.ui.components.label
import dev.aura.android.ui.theme.Spacing

/** The most lines the composer grows to before it scrolls. */
private const val COMPOSER_MAX_LINES = 6

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(serverId: String, sessionId: String, onBack: () -> Unit) {
    val treeVm = appViewModel(key = "tree:$serverId:$sessionId") { SessionTreeViewModel(it, serverId, sessionId) }
    val tree by treeVm.tree.collectAsStateWithLifecycle()
    // The leader's chat or one of its workers'; opening a worker (from the inbox) selects it.
    var selectedId by rememberSaveable(sessionId) { mutableStateOf(sessionId) }
    val leader = tree.firstOrNull()
    // A leader (an orchestrator, a feature owner, or one with workers) has a Team tab.
    val hasTeam = leader != null && (tree.size > 1 || leader.orchestrator || leader.featureOwner)
    val showTeam = hasTeam && selectedId == TEAM_TAB
    val shownId = if (showTeam) leader!!.id else selectedId.takeIf { id -> tree.isEmpty() || tree.any { it.id == id } } ?: tree.first().id
    val teamFeature by treeVm.feature.collectAsStateWithLifecycle()
    val replies by treeVm.replies.collectAsStateWithLifecycle()
    LaunchedEffect(showTeam, tree.size) {
        if (showTeam) treeVm.loadReplies(tree.drop(1).map { it.id })
    }

    val vm = appViewModel(key = "session:$serverId:$shownId") { SessionViewModel(it, serverId, shownId) }
    // While this session is on screen, its news is not notified (and what was is taken away).
    val openSessions = (LocalContext.current.applicationContext as AuraApplication).container.openSession
    LifecycleResumeEffect(serverId, shownId) {
        val open = OpenSession(serverId, shownId)
        openSessions.value = open
        onPauseOrDispose { openSessions.compareAndSet(open, null) }
    }
    val session by vm.session.collectAsStateWithLifecycle()
    val transcript by vm.transcript.collectAsStateWithLifecycle()
    val connection by vm.connectionState.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val feature by vm.feature.collectAsStateWithLifecycle()
    val answering by vm.answering.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()
    val online = connection is ConnectionState.Online
    val running = session?.status == "running" || transcript?.turnRunning == true
    var actions by remember { mutableStateOf(false) }
    var confirmStop by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var newWorkspace by remember { mutableStateOf(false) }
    val workspaces by vm.workspaces.collectAsStateWithLifecycle()
    val list = remember(shownId) { LazyListState() }
    val follow = rememberFollowLatest(list)

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        val head = leader ?: session
                        Column {
                            Text(
                                head?.title?.ifBlank { null } ?: stringResource(R.string.untitled_session),
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
                if (hasTeam) WorkerTabs(tree, if (showTeam) TEAM_TAB else shownId, onSelect = { selectedId = it })
            }
        },
        bottomBar = {
            if (session?.isStructured != false && !showTeam) {
                key(shownId) { Composer(enabled = online && !sending, sending = sending, onSend = vm::send) }
            }
        },
        floatingActionButton = {
            AnimatedVisibility(visible = !showTeam && transcript != null && !follow.atLatest, enter = scaleIn() + fadeIn(), exit = scaleOut() + fadeOut()) {
                JumpToLatest(follow.unread, onClick = follow::jump)
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val t = transcript
        val s = session
        when {
            showTeam -> TeamView(
                workers = tree.drop(1),
                feature = teamFeature,
                replies = replies,
                onOpen = { selectedId = it },
                contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.m),
            )
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
                val newest = rows.lastOrNull()
                follow.Track(
                    count = rows.size + t.approvals.size + t.inputs.size,
                    newestKey = newest?.key,
                    newestLength = (newest as? TranscriptRow.Agent)?.item?.text?.length ?: 0,
                )
                // Laid out from the bottom: it opens at the latest messages, and older ones are above.
                LazyColumn(
                    state = list,
                    reverseLayout = true,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(top = padding.calculateTopPadding() + Spacing.s, bottom = padding.calculateBottomPadding() + Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.m, Alignment.Bottom),
                ) {
                    if (s?.state == SessionState.Failed && s.lastError != null && t.lastError == null) {
                        item(key = "session-error") {
                            Text(s.lastError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.m))
                        }
                    }
                    items(t.inputs.asReversed(), key = { "input:" + it.id }) { request ->
                        QuestionsCard(
                            request,
                            enabled = online,
                            onAnswer = { vm.answer(request, it) },
                            onDismiss = { vm.answer(request, emptyMap(), declined = true) },
                            modifier = Modifier.animateItem(),
                        )
                    }
                    items(t.approvals.asReversed(), key = { "approval:" + it.id }) { approval ->
                        ApprovalCard(approval, enabled = online, onRespond = { vm.respond(approval, it) }, modifier = Modifier.animateItem())
                    }
                    if (running) {
                        item(key = "working") {
                            LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = Spacing.m))
                        }
                    }
                    t.lastError?.let { error ->
                        item(key = "turn-error") {
                            Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.m))
                        }
                    }
                    // No placement animation: as the latest entry streams in, it pushes the
                    // rest up every frame, and an animated move would lag behind and overlap it.
                    items(rows.asReversed(), key = { it.key }) { row ->
                        TranscriptRowView(row, Modifier.animateItem(placementSpec = null)) { card, modifier ->
                            FeatureCardRow(card, feature, answering, online, vm::answerFeature, modifier)
                        }
                    }
                    if (rows.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                stringResource(R.string.transcript_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = Spacing.m),
                            )
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
            if (workspaces.isNotEmpty() && leader != null) {
                SheetAction(Icons.Outlined.DriveFileMove, stringResource(R.string.move_to_workspace)) { actions = false; moving = true }
            }
            Box(Modifier.navigationBarsPadding())
        }
    }
    if (moving && leader != null) {
        MoveToWorkspaceDialog(
            workspaces = workspaces,
            current = leader.workspace,
            onMove = { moving = false; vm.moveToWorkspace(leader.id, it) },
            onNew = { moving = false; newWorkspace = true },
            onDismiss = { moving = false },
        )
    }
    if (newWorkspace && leader != null) {
        NewWorkspaceDialog(
            onCreate = { newWorkspace = false; vm.moveToWorkspace(leader.id, null, it) },
            onDismiss = { newWorkspace = false },
        )
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

/**
 * A card from the owner's feature record, as the desktop shows it: a decision
 * is answerable here and shows its answer once given; other cards show their
 * text, their detail being on the computer.
 */
@Composable
private fun FeatureCardRow(
    row: TranscriptRow.Feature,
    feature: Feature?,
    answering: Set<String>,
    online: Boolean,
    onAnswer: (UserQuestion, String?, String) -> Unit,
    modifier: Modifier,
) {
    val question = feature?.questions?.firstOrNull { it.id == row.card.id }.takeIf { row.card.kind == "decision" }
    if (question != null) {
        DecisionCard(
            question,
            answering = question.id in answering || !online,
            onAnswer = { option, text -> onAnswer(question, option, text) },
            modifier = modifier,
        )
    } else if (row.item.text.isNotBlank()) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = MaterialTheme.shapes.medium,
            modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
        ) {
            MarkdownText(row.item.text, Modifier.padding(Spacing.m))
        }
    }
}

/** The leader's chat, its team, and a tab per worker or team member with its state as an icon and in words. */
@Composable
private fun WorkerTabs(tree: List<Session>, selectedId: String, onSelect: (String) -> Unit) {
    val ids = listOf(tree.first().id, TEAM_TAB) + tree.drop(1).map { it.id }
    PrimaryScrollableTabRow(selectedTabIndex = ids.indexOf(selectedId).coerceAtLeast(0), edgePadding = Spacing.m) {
        Tab(
            selected = selectedId == tree.first().id,
            onClick = { onSelect(tree.first().id) },
            icon = { Icon(Icons.AutoMirrored.Outlined.Chat, contentDescription = null) },
            text = { Text(stringResource(R.string.tab_chat)) },
        )
        Tab(
            selected = selectedId == TEAM_TAB,
            onClick = { onSelect(TEAM_TAB) },
            icon = { Icon(Icons.Outlined.Groups, contentDescription = null) },
            text = { Text(stringResource(R.string.tab_team)) },
        )
        for (s in tree.drop(1)) {
            val status = s.teamStatus
            val stateLabel = stringResource(status.label)
            Tab(
                selected = s.id == selectedId,
                onClick = { onSelect(s.id) },
                modifier = Modifier.semantics { stateDescription = stateLabel },
                icon = { Icon(status.icon, contentDescription = null, tint = status.tint()) },
                text = {
                    Text(
                        s.specialistName ?: s.title.ifBlank { stringResource(R.string.untitled_session) },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
            )
        }
    }
}

/** The status's own color for an icon on the surface (3:1 is enough for an icon beside its words). */
@Composable
private fun TeamStatus.tint(): Color = MaterialTheme.colorScheme.let { c ->
    when (this) {
        TeamStatus.WaitingOnYou -> c.tertiary
        TeamStatus.Working -> c.primary
        TeamStatus.Failed -> c.error
        TeamStatus.Done, TeamStatus.Idle -> c.onSurfaceVariant
    }
}

/** The Team tab's id among the sessions' ids. */
private const val TEAM_TAB = "team"

@Composable
private fun JumpToLatest(unread: Int, onClick: () -> Unit) {
    SmallFloatingActionButton(onClick = onClick) {
        BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) {
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.jump_to_latest))
        }
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
                keyboardOptions = ProseKeyboard,
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
