package dev.aura.android.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.highlightedCodeBlock
import com.mikepenz.markdown.compose.elements.highlightedCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.elements.MarkdownCheckBox
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import dev.aura.android.ui.theme.Spacing
import dev.aura.android.ui.theme.codeSmall
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate

/**
 * [markdown] rendered as the desktop renders it (GitHub flavour: headings,
 * emphasis and strike-through, code with syntax highlighting, nested and task
 * lists, quotes, tables, rules, links), in the theme's type scale and colors.
 * Text takes the color around it, so it reads on any container. Links open
 * only on the web or in mail; the text can be selected and copied.
 */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier, streaming: Boolean = false) {
    // While text streams in, it is parsed at most every STREAM_FRAME_MS, with an open
    // code fence closed, and the last result stays on screen while the next one parses:
    // the message only ever grows, instead of collapsing and re-expanding on every delta.
    val shown = if (streaming) throttled(markdown, STREAM_FRAME_MS) else markdown
    val state = rememberMarkdownState(if (streaming) closeOpenFence(shown) else shown, retainState = true)
    val outer = LocalUriHandler.current
    val safe = remember(outer) {
        object : UriHandler {
            override fun openUri(uri: String) {
                if (uri.isSafeLink()) outer.openUri(uri)
            }
        }
    }
    val text = LocalContentColor.current
    val type = MaterialTheme.typography
    CompositionLocalProvider(LocalUriHandler provides safe) {
        SelectionContainer(modifier) {
            Markdown(
                markdownState = state,
                colors = markdownColor(text = text),
                // Headings at title sizes, as the desktop sizes them in a chat; body at the app's body size.
                typography = markdownTypography(
                    h1 = type.titleLarge,
                    h2 = type.titleMedium,
                    h3 = type.titleSmall,
                    h4 = type.titleSmall,
                    h5 = type.titleSmall,
                    h6 = type.titleSmall,
                    text = type.bodyLarge,
                    paragraph = type.bodyLarge,
                    ordered = type.bodyLarge,
                    bullet = type.bodyLarge,
                    list = type.bodyLarge,
                    quote = type.bodyLarge.copy(fontStyle = FontStyle.Italic),
                    code = type.codeSmall,
                ),
                components = remember {
                    markdownComponents(
                        codeBlock = highlightedCodeBlock,
                        codeFence = highlightedCodeFence,
                        checkbox = { MarkdownCheckBox(it.content, it.node, it.typography.text) },
                    )
                },
            )
        }
    }
}

/** Preformatted text on a tinted surface, scrolling sideways rather than wrapping. */
@Composable
fun CodeBlock(code: String, modifier: Modifier = Modifier, style: TextStyle = MaterialTheme.typography.codeSmall) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = MaterialTheme.shapes.small,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            code,
            style = style,
            softWrap = false,
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(Spacing.s),
        )
    }
}

/** Only web and mail links open; an agent's text decides nothing else on the phone. */
private fun String.isSafeLink() = listOf("https://", "http://", "mailto:").any { startsWith(it, ignoreCase = true) }

/** How often a streaming message is re-rendered, at most. */
private const val STREAM_FRAME_MS = 100L

/**
 * [value], updated at most every [periodMs] while it keeps changing: each
 * update shows the latest value, so text arriving faster than that still shows
 * as it comes (a debounce would show nothing until it stopped).
 */
@Composable
private fun throttled(value: String, periodMs: Long): String {
    val latest by rememberUpdatedState(value)
    var shown by remember { mutableStateOf(value) }
    LaunchedEffect(periodMs) {
        snapshotFlow { latest }.conflate().collect {
            shown = it
            delay(periodMs)
        }
    }
    return shown
}

/**
 * [streamed] with a code fence that is still open closed, so a half-streamed
 * code block renders as code now rather than turning into one later.
 */
internal fun closeOpenFence(streamed: String): String {
    // A fence still arriving ("`" or "``" on the last line) would show as stray text for a frame.
    val markdown = if (PARTIAL_FENCE.matches(streamed.substringAfterLast('\n'))) streamed.substringBeforeLast('\n', "") else streamed
    var open: String? = null
    for (line in markdown.lineSequence()) {
        val t = line.trimStart()
        val fence = Regex("^(`{3,}|~{3,})").find(t)?.value ?: continue
        open = when {
            open == null -> fence
            fence.first() == open.first() && fence.length >= open.length && t.trimEnd() == fence -> null
            else -> open
        }
    }
    return if (open == null) markdown else markdown.trimEnd('\n') + "\n" + open
}

private val PARTIAL_FENCE = Regex("""\s*(`{1,2}|~{1,2})""")
