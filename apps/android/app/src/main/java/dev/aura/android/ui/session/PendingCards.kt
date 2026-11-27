package dev.aura.android.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import dev.aura.android.R
import dev.aura.android.protocol.Approval
import dev.aura.android.protocol.Question
import dev.aura.android.protocol.UserInputRequest
import dev.aura.android.ui.components.CodeBlock
import dev.aura.android.ui.theme.Spacing
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Composable
private fun PendingCard(icon: ImageVector, title: String, modifier: Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(icon, contentDescription = null)
                Text(title, style = MaterialTheme.typography.titleMedium)
            }
            content()
        }
    }
}

/** An approval the agent waits for, with the options it offers. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ApprovalCard(approval: Approval, enabled: Boolean, onRespond: (option: String) -> Unit, modifier: Modifier = Modifier) {
    PendingCard(Icons.Outlined.PanTool, stringResource(R.string.approval_needed), modifier) {
        Text(approval.title, style = MaterialTheme.typography.bodyLarge)
        approval.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        approval.preview()?.let { CodeBlock(it) }
        val options = approval.options.ifEmpty { listOf("accept", "decline") }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.s, Alignment.End),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if ("decline" in options) TextButton(onClick = { onRespond("decline") }, enabled = enabled) { Text(stringResource(R.string.decline)) }
            if ("accept_for_session" in options) {
                OutlinedButton(onClick = { onRespond("accept_for_session") }, enabled = enabled) { Text(stringResource(R.string.allow_for_session)) }
            }
            if ("accept" in options) Button(onClick = { onRespond("accept") }, enabled = enabled) { Text(stringResource(R.string.allow)) }
        }
    }
}

/** What the agent wants to run or change, from the approval's payload. */
private fun Approval.preview(): String? {
    (payload["command"] as? JsonPrimitive)?.contentOrNull?.let { return it }
    (payload["command"] as? JsonArray)?.let { argv -> return argv.joinToString(" ") { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() } }
    (payload["changes"] as? JsonArray)?.let { changes ->
        return changes.joinToString("\n") { change ->
            ((change as? JsonObject)?.get("path") as? JsonPrimitive)?.contentOrNull ?: change.toString()
        }
    }
    payload["input"]?.let { return it.toString() }
    return null
}

/** Questions the agent asks, answered together. */
@Composable
fun QuestionsCard(
    request: UserInputRequest,
    enabled: Boolean,
    onAnswer: (Map<String, List<String>>) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val selected = remember(request.id) { mutableStateMapOf<String, Set<String>>() }
    val typed = remember(request.id) { mutableStateMapOf<String, String>() }
    PendingCard(Icons.AutoMirrored.Outlined.HelpOutline, stringResource(R.string.question_title), modifier) {
        for (question in request.questions) {
            QuestionView(
                question = question,
                selected = selected[question.id].orEmpty(),
                text = typed[question.id].orEmpty(),
                onSelect = { label ->
                    val current = selected[question.id].orEmpty()
                    selected[question.id] = when {
                        !question.multiSelect -> setOf(label)
                        label in current -> current - label
                        else -> current + label
                    }
                },
                onText = { typed[question.id] = it },
            )
        }
        val answers = request.questions.associate { q ->
            q.id to (selected[q.id].orEmpty().toList() + listOfNotNull(typed[q.id]?.trim()?.takeIf { it.isNotEmpty() }))
        }
        val complete = answers.values.all { it.isNotEmpty() }
        Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            TextButton(onClick = onDismiss, enabled = enabled) { Text(stringResource(R.string.dismiss)) }
            Button(onClick = { onAnswer(answers) }, enabled = enabled && complete) { Text(stringResource(R.string.answer)) }
        }
    }
}

@Composable
private fun QuestionView(
    question: Question,
    selected: Set<String>,
    text: String,
    onSelect: (String) -> Unit,
    onText: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        question.header?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
        Text(question.question, style = MaterialTheme.typography.bodyLarge)
        for (option in question.options) {
            val checked = option.label in selected
            val select = Modifier.fillMaxWidth().let {
                if (question.multiSelect) {
                    it.toggleable(value = checked, role = Role.Checkbox) { onSelect(option.label) }
                } else {
                    it.selectable(selected = checked, role = Role.RadioButton) { onSelect(option.label) }
                }
            }
            Row(select.padding(vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                if (question.multiSelect) Checkbox(checked = checked, onCheckedChange = null) else RadioButton(selected = checked, onClick = null)
                Column(Modifier.padding(start = Spacing.s)) {
                    Text(option.label, style = MaterialTheme.typography.bodyLarge)
                    option.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        if (question.allowFreeText || question.options.isEmpty()) {
            OutlinedTextField(
                value = text,
                onValueChange = onText,
                label = { Text(stringResource(if (question.options.isEmpty()) R.string.your_answer else R.string.other_answer)) },
                visualTransformation = if (question.secret) PasswordVisualTransformation() else VisualTransformation.None,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
