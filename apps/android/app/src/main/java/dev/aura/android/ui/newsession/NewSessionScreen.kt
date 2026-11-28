package dev.aura.android.ui.newsession

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.R
import dev.aura.android.protocol.Autonomy
import dev.aura.android.protocol.folderName
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.ProseKeyboard
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.theme.Spacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionScreen(serverId: String, onBack: () -> Unit, onCreated: (sessionId: String) -> Unit) {
    val vm = appViewModel(key = "new:$serverId") { NewSessionViewModel(it, serverId) }
    val options by vm.options.collectAsStateWithLifecycle()
    val form by vm.form.collectAsStateWithLifecycle()
    val models by vm.models.collectAsStateWithLifecycle()
    val creating by vm.creating.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    LaunchedEffect(vm) { vm.created.collect(onCreated) }
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.new_session)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val o = options
        if (o == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        val agent = o.agents.getOrNull(form.agentIndex.coerceIn(0, (o.agents.size - 1).coerceAtLeast(0)))
        val caps = agent?.info?.capabilities
        val agentModels = agent?.let { models[it.provider] }.orEmpty()
        val chosenModel = agentModels.firstOrNull { it.id == form.model } ?: agentModels.firstOrNull { it.isDefault }
        val isRepo = o.projects.firstOrNull { form.project.trim().startsWith(it.path) }?.repo == true
        val owns = form.kind == SessionKind.FeatureOwner
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = Spacing.contentMaxWidth).fillMaxWidth().padding(Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                KindPicker(form.kind) { kind -> vm.edit { it.copy(kind = kind) } }
                Text(
                    stringResource(
                        when (form.kind) {
                            SessionKind.Agent -> R.string.kind_agent_desc
                            SessionKind.Orchestrator -> R.string.kind_orchestrator_desc
                            SessionKind.FeatureOwner -> R.string.kind_owner_desc
                        },
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (owns) {
                    OutlinedTextField(
                        value = form.goal,
                        onValueChange = { g -> vm.edit { it.copy(goal = g) } },
                        label = { Text(stringResource(R.string.feature_goal)) },
                        placeholder = { Text(stringResource(R.string.feature_goal_hint)) },
                        minLines = 4,
                        keyboardOptions = ProseKeyboard,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    AutonomyField(form.autonomy) { a -> vm.edit { it.copy(autonomy = a) } }
                }

                Section(stringResource(R.string.section_where))
                if (form.orchestrates) {
                    SwitchRow(
                        checked = form.orchestratorFolder,
                        title = stringResource(R.string.use_a_folder),
                        supporting = stringResource(if (owns) R.string.no_folder_owner else R.string.no_folder_orchestrator),
                        icon = Icons.Outlined.Folder,
                    ) { on -> vm.edit { it.copy(orchestratorFolder = on) } }
                }
                if (!form.noFolder) {
                    ProjectField(form.project, o.projects.map { it.path }, onChange = { p -> vm.edit { it.copy(project = p) } })
                    if (isRepo) {
                        SwitchRow(
                            checked = form.worktree,
                            title = stringResource(R.string.worktree),
                            supporting = stringResource(R.string.worktree_desc),
                            icon = Icons.Outlined.AccountTree,
                        ) { on -> vm.edit { it.copy(worktree = on) } }
                        if (form.worktree) {
                            OutlinedTextField(
                                value = form.branch,
                                onValueChange = { b -> vm.edit { it.copy(branch = b.replace(' ', '-'), branchTouched = true) } },
                                label = { Text(stringResource(R.string.branch)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
                if (o.workspaces.isNotEmpty()) {
                    ChoiceField(
                        label = stringResource(R.string.workspace),
                        icon = Icons.Outlined.SpaceDashboard,
                        choices = listOf("" to stringResource(R.string.workspace_default)) + o.workspaces.map { it.id to it.name },
                        selected = form.workspace.orEmpty(),
                    ) { w -> vm.edit { it.copy(workspace = w.ifEmpty { null }) } }
                }

                Section(stringResource(R.string.section_agent))
                if (o.agents.isEmpty()) {
                    Text(stringResource(R.string.no_agents), color = MaterialTheme.colorScheme.error)
                } else {
                    ChoiceField(
                        label = stringResource(R.string.agent),
                        icon = Icons.Outlined.SmartToy,
                        choices = o.agents.mapIndexed { i, a -> i.toString() to a.name },
                        selected = form.agentIndex.toString(),
                    ) { i -> vm.edit { it.copy(agentIndex = i.toInt()) } }
                }
                val default = stringResource(R.string.agent_default)
                if (agentModels.isNotEmpty()) {
                    ChoiceField(
                        label = stringResource(R.string.model),
                        icon = Icons.Outlined.Memory,
                        choices = listOf("" to default) + agentModels.map { it.id to it.displayName },
                        selected = form.model,
                    ) { m -> vm.edit { it.copy(model = m) } }
                }
                val efforts = chosenModel?.efforts.orEmpty()
                if (efforts.isNotEmpty()) {
                    ChoiceField(
                        label = stringResource(R.string.effort),
                        icon = Icons.Outlined.Speed,
                        choices = listOf("" to (chosenModel?.defaultEffort?.let { "$default ($it)" } ?: default)) + efforts.map { it to it },
                        selected = form.effort,
                    ) { e -> vm.edit { it.copy(effort = e) } }
                }
                if (caps?.permissionModes.orEmpty().isNotEmpty()) {
                    ChoiceField(
                        label = stringResource(R.string.permission_mode),
                        icon = Icons.Outlined.Security,
                        choices = listOf("" to default) + caps!!.permissionModes.map { it to it },
                        selected = form.permission,
                    ) { p -> vm.edit { it.copy(permission = p) } }
                }
                if (caps?.sandboxModes.orEmpty().isNotEmpty()) {
                    ChoiceField(
                        label = stringResource(R.string.sandbox_mode),
                        icon = Icons.Outlined.Shield,
                        choices = listOf("" to default) + caps!!.sandboxModes.map { it to it },
                        selected = form.sandbox,
                    ) { s -> vm.edit { it.copy(sandbox = s) } }
                }

                Section(stringResource(R.string.section_details))
                OutlinedTextField(
                    value = form.title,
                    onValueChange = { t -> vm.edit { it.copy(title = t) } },
                    label = { Text(stringResource(R.string.title_optional)) },
                    singleLine = true,
                    keyboardOptions = ProseKeyboard,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.group,
                    onValueChange = { g -> vm.edit { it.copy(group = g) } },
                    label = { Text(stringResource(R.string.group_optional)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!owns) {
                    OutlinedTextField(
                        value = form.prompt,
                        onValueChange = { p -> vm.edit { it.copy(prompt = p) } },
                        label = { Text(stringResource(R.string.first_prompt)) },
                        minLines = 4,
                        keyboardOptions = ProseKeyboard,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = form.systemPrompt,
                    onValueChange = { s -> vm.edit { it.copy(systemPrompt = s) } },
                    label = { Text(stringResource(R.string.system_prompt_optional)) },
                    supportingText = { Text(stringResource(R.string.system_prompt_desc)) },
                    minLines = 2,
                    keyboardOptions = ProseKeyboard,
                    modifier = Modifier.fillMaxWidth(),
                )

                if (creating) LinearProgressIndicator(Modifier.fillMaxWidth())
                val ready = agent != null && (form.noFolder || form.project.isNotBlank()) && (!owns || form.goal.isNotBlank())
                Button(onClick = vm::create, enabled = !creating && ready, modifier = Modifier.align(Alignment.End)) {
                    Text(stringResource(R.string.start_session))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KindPicker(selected: SessionKind, onSelect: (SessionKind) -> Unit) {
    val labels = listOf(R.string.kind_agent, R.string.kind_orchestrator, R.string.kind_owner)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        SessionKind.entries.forEachIndexed { i, kind ->
            SegmentedButton(
                selected = kind == selected,
                onClick = { onSelect(kind) },
                shape = SegmentedButtonDefaults.itemShape(i, SessionKind.entries.size),
            ) {
                Text(stringResource(labels[i]), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The feature's own autonomy, or the server's setting for every feature owner. */
@Composable
private fun ColumnScope.AutonomyField(autonomy: Autonomy?, onChange: (Autonomy?) -> Unit) {
    SwitchRow(
        checked = autonomy != null,
        title = stringResource(R.string.own_autonomy),
        supporting = stringResource(R.string.own_autonomy_desc),
        icon = null,
    ) { on -> onChange(if (on) Autonomy.DEFAULT else null) }
    if (autonomy == null) return
    val levels = listOf(
        Autonomy.AUTONOMOUS to R.string.autonomy_autonomous,
        Autonomy.BLOCKING to R.string.autonomy_blocking,
        Autonomy.CHECKPOINTS to R.string.autonomy_checkpoints,
    )
    Column(Modifier.selectableGroup()) {
        for ((level, label) in levels) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .selectable(selected = autonomy.level == level, role = Role.RadioButton) { onChange(autonomy.copy(level = level)) }
                    .padding(vertical = Spacing.xs),
            ) {
                RadioButton(selected = autonomy.level == level, onClick = null)
                Text(stringResource(label), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = Spacing.m))
            }
        }
    }
    if (autonomy.level == Autonomy.CHECKPOINTS) {
        val names = listOf(R.string.checkpoint_after_design, R.string.checkpoint_before_implementation, R.string.checkpoint_before_delivery)
        Autonomy.ALL_CHECKPOINTS.forEachIndexed { i, c ->
            val on = c in autonomy.checkpoints
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .toggleable(value = on, role = Role.Checkbox) {
                        onChange(autonomy.copy(checkpoints = Autonomy.ALL_CHECKPOINTS.filter { x -> if (x == c) it else x in autonomy.checkpoints }))
                    }
                    .padding(start = Spacing.l, top = Spacing.xs, bottom = Spacing.xs),
            ) {
                Checkbox(checked = on, onCheckedChange = null)
                Text(stringResource(names[i]), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = Spacing.m))
            }
        }
    }
}

@Composable
private fun Section(title: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        HorizontalDivider()
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun SwitchRow(checked: Boolean, title: String, supporting: String, icon: ImageVector?, onChange: (Boolean) -> Unit) {
    ListItem(
        modifier = Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        leadingContent = icon?.let { { Icon(it, contentDescription = null) } },
        headlineContent = { Text(title) },
        supportingContent = { Text(supporting) },
        trailingContent = { Switch(checked = checked, onCheckedChange = null) },
    )
}

/** A read-only dropdown of [choices] (value to label). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChoiceField(label: String, icon: ImageVector, choices: List<Pair<String, String>>, selected: String, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = choices.firstOrNull { it.first == selected }?.second ?: choices.firstOrNull()?.second.orEmpty(),
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            leadingIcon = { Icon(icon, contentDescription = null) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for ((value, text) in choices) {
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = { onChange(value); expanded = false },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                )
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
