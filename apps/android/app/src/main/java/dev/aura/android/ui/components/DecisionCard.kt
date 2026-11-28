package dev.aura.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.protocol.UserQuestion
import dev.aura.android.ui.theme.Spacing

/** Free text the user writes: sentences, capitalized and corrected as they type. */
val ProseKeyboard = KeyboardOptions(
    capitalization = KeyboardCapitalization.Sentences,
    autoCorrectEnabled = true,
    keyboardType = KeyboardType.Text,
)

/**
 * A feature owner's question to the user, as the desktop's decision card: the
 * options with the recommended one marked, room for a note, and once answered
 * (or withdrawn) what became of it. [overline] says where it comes from (the
 * inbox names the server and feature); [actions] adds buttons beside Answer.
 */
@Composable
fun DecisionCard(
    question: UserQuestion,
    answering: Boolean,
    onAnswer: (option: String?, text: String) -> Unit,
    modifier: Modifier = Modifier,
    overline: String? = null,
    actions: @Composable () -> Unit = {},
) {
    val q = question
    var option by rememberSaveable(q.id) { mutableStateOf<String?>(null) }
    var text by rememberSaveable(q.id) { mutableStateOf("") }
    Card(
        colors = if (q.open) {
            CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
            )
        } else {
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)
        },
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(if (q.open) Icons.Outlined.Flag else Icons.Outlined.CheckCircle, contentDescription = null)
                Column {
                    overline?.let { Text(it, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    Text(
                        stringResource(
                            when {
                                q.kind == "checkpoint" -> R.string.decision_checkpoint
                                q.kind == "irreversible" -> R.string.decision_irreversible
                                else -> R.string.decision_for_you
                            },
                        ),
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
            Text(q.question, style = MaterialTheme.typography.titleMedium)
            q.context.takeIf { it.isNotBlank() }?.let { MarkdownText(it) }
            val answer = q.answer
            when {
                q.open -> {
                    Column(Modifier.selectableGroup()) {
                        for (o in q.options) {
                            val selected = option == o.label
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .selectable(selected = selected, role = Role.RadioButton, enabled = !answering) {
                                        option = if (selected) null else o.label
                                    }
                                    .padding(vertical = Spacing.xs),
                            ) {
                                RadioButton(selected = selected, onClick = null)
                                Column(Modifier.padding(start = Spacing.s)) {
                                    Text(
                                        if (o.label == q.recommended) stringResource(R.string.recommended_option, o.label) else o.label,
                                        style = MaterialTheme.typography.bodyLarge,
                                    )
                                    o.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                }
                            }
                        }
                    }
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        enabled = !answering,
                        label = { Text(stringResource(if (q.options.isEmpty()) R.string.your_answer else R.string.add_a_note)) },
                        keyboardOptions = ProseKeyboard,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (answering) LinearProgressIndicator(Modifier.fillMaxWidth())
                    Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        actions()
                        Button(onClick = { onAnswer(option, text) }, enabled = !answering && (option != null || text.isNotBlank())) {
                            Text(stringResource(R.string.answer))
                        }
                    }
                }
                answer != null -> Text(
                    stringResource(R.string.you_answered, listOfNotNull(answer.option, answer.text.takeIf { it.isNotBlank() }).joinToString(" · ")),
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> Text(stringResource(R.string.decision_withdrawn), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
