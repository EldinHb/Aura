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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import dev.aura.android.ui.sessions.SessionRow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(onOpen: (serverId: String, sessionId: String) -> Unit) {
    val vm = appViewModel { InboxViewModel(it) }
    val waiting by vm.waiting.collectAsStateWithLifecycle()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = { LargeTopAppBar(title = { Text(stringResource(R.string.inbox_title)) }, scrollBehavior = scrollBehavior) },
    ) { padding ->
        val list = waiting
        when {
            list == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            list.isEmpty() -> EmptyState(
                icon = Icons.Outlined.DoneAll,
                title = stringResource(R.string.inbox_empty_title),
                body = stringResource(R.string.inbox_empty_body),
                modifier = Modifier.padding(padding),
            )
            else -> LazyColumn(contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding())) {
                items(list, key = { it.serverId + ":" + it.session.id }) { w ->
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
