package dev.aura.android.ui.newsession

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.protocol.folderName
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.theme.Spacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionScreen(serverId: String, onBack: () -> Unit, onCreated: (sessionId: String) -> Unit) {
    val vm = appViewModel(key = "new:$serverId") { NewSessionViewModel(it, serverId) }
    val options by vm.options.collectAsStateWithLifecycle()
    val creating by vm.creating.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    LaunchedEffect(vm) { vm.created.collect(onCreated) }

    var project by rememberSaveable { mutableStateOf("") }
    var agentIndex by rememberSaveable { mutableStateOf(0) }
    var prompt by rememberSaveable { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.new_session)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val o = options
        if (o == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        LaunchedEffect(o) {
            if (project.isEmpty()) project = o.projects.firstOrNull()?.path.orEmpty()
        }
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = Spacing.contentMaxWidth).fillMaxWidth().padding(Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                ProjectField(project, o.projects.map { it.path }, onChange = { project = it })
                if (o.agents.isEmpty()) {
                    Text(stringResource(R.string.no_agents), color = MaterialTheme.colorScheme.error)
                } else {
                    AgentField(o.agents, agentIndex.coerceIn(o.agents.indices), onChange = { agentIndex = it })
                }
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text(stringResource(R.string.first_prompt)) },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (creating) LinearProgressIndicator(Modifier.fillMaxWidth())
                Button(
                    onClick = { vm.create(project, o.agents[agentIndex.coerceIn(o.agents.indices)], prompt) },
                    enabled = !creating && project.isNotBlank() && o.agents.isNotEmpty() && prompt.isNotBlank(),
                    modifier = Modifier.align(Alignment.End),
                ) {
                    Text(stringResource(R.string.start_session))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectField(value: String, projects: List<String>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it && projects.isNotEmpty() }) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(stringResource(R.string.project)) },
            supportingText = { Text(stringResource(R.string.project_help)) },
            leadingIcon = { Icon(Icons.Outlined.Folder, contentDescription = null) },
            trailingIcon = { if (projects.isNotEmpty()) ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (path in projects) {
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(folderName(path))
                            Text(path, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    onClick = { onChange(path); expanded = false },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentField(agents: List<AgentChoice>, selected: Int, onChange: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = agents[selected].name,
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.agent)) },
            leadingIcon = { Icon(Icons.Outlined.SmartToy, contentDescription = null) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            agents.forEachIndexed { i, agent ->
                DropdownMenuItem(
                    text = { Text(agent.name) },
                    onClick = { onChange(i); expanded = false },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                )
            }
        }
    }
}
