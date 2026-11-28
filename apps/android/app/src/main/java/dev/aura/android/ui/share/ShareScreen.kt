package dev.aura.android.ui.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.AuraApplication
import dev.aura.android.R
import dev.aura.android.protocol.Forest
import dev.aura.android.protocol.Session
import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.isStructured
import dev.aura.android.protocol.projectPath
import dev.aura.android.ui.components.EmptyState
import dev.aura.android.ui.components.SessionStateIcon
import dev.aura.android.protocol.state
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

private data class Target(val serverId: String, val serverName: String, val session: Session, val leader: Session?)

/** Picks the session images shared from another app go to: any agent session on a connected server, latest first. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalCoroutinesApi::class)
@Composable
fun ShareScreen(count: Int, onBack: () -> Unit, onPick: (serverId: String, sessionId: String) -> Unit) {
    val container = (LocalContext.current.applicationContext as AuraApplication).container
    val flow = remember(container) {
        combine(container.store.servers, container.connections.flatMapLatest { map ->
            if (map.isEmpty()) flowOf(emptyMap()) else combine(map.map { (id, c) -> c.sessions.map { id to it.orEmpty() } }) { it.toMap() }
        }) { servers, sessions ->
            servers.flatMap { server ->
                val list = sessions[server.id].orEmpty()
                val forest = Forest(list)
                list.filter { !it.archived && it.isStructured }.map { s -> Target(server.id, server.name, s, forest.parentOf(s.id)?.let(forest::leaderOf)) }
            }.sortedByDescending { it.session.lastActivity }
        }
    }
    val targets by flow.collectAsStateWithLifecycle(null)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(pluralStringResource(R.plurals.share_title, count, count)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back)) } },
            )
        },
    ) { padding ->
        val list = targets
        when {
            list == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            list.isEmpty() -> EmptyState(Icons.Outlined.CloudOff, stringResource(R.string.share_to_aura), stringResource(R.string.share_empty), Modifier.padding(padding))
            else -> LazyColumn(contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding())) {
                items(list, key = { it.serverId + ":" + it.session.id }) { t ->
                    ListItem(
                        modifier = Modifier.clickable { onPick(t.serverId, t.session.id) },
                        overlineContent = {
                            Text(
                                listOfNotNull(t.serverName, t.leader?.title?.takeIf { it.isNotBlank() }, folderName(t.session.projectPath)).joinToString(" · "),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        leadingContent = { SessionStateIcon(t.session.state) },
                        headlineContent = {
                            Text(
                                t.session.specialistName ?: t.session.title.ifBlank { stringResource(R.string.untitled_session) },
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        },
                    )
                }
            }
        }
    }
}
