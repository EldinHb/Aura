package dev.aura.android.ui.inbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import dev.aura.android.R
import dev.aura.android.ui.theme.Spacing

/** A feature owner's question, answered right here: an option, words of the user's own, or both. */
@Composable
fun FeatureQuestionCard(
    waiting: WaitingQuestion,
    answering: Boolean,
    onAnswer: (option: String?, text: String) -> Unit,
    onOpenOwner: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val q = waiting.question
    var option by rememberSaveable(waiting.key) { mutableStateOf<String?>(null) }
    var text by rememberSaveable(waiting.key) { mutableStateOf("") }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(Icons.Outlined.Flag, contentDescription = null)
                Text(
                    "${waiting.serverName} · ${waiting.feature.goal.ifBlank { stringResource(R.string.feature) }}",
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                stringResource(if (q.kind == "irreversible") R.string.feature_question_irreversible else R.string.feature_question),
                style = MaterialTheme.typography.labelMedium,
            )
            Text(q.question, style = MaterialTheme.typography.titleMedium)
            q.context.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
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
                modifier = Modifier.fillMaxWidth(),
            )
            if (answering) LinearProgressIndicator(Modifier.fillMaxWidth())
            Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                TextButton(onClick = onOpenOwner) { Text(stringResource(R.string.open_feature_owner)) }
                Button(
                    onClick = { onAnswer(option, text) },
                    enabled = !answering && (option != null || text.isNotBlank()),
                ) {
                    Text(stringResource(R.string.answer))
                }
            }
        }
    }
}
