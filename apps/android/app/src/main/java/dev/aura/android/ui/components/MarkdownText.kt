package dev.aura.android.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import dev.aura.android.ui.theme.Spacing
import dev.aura.android.ui.theme.codeSmall

/** [markdown] rendered with the theme's type scale; the text can be selected and copied. */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier) {
    val blocks = remember(markdown) { Markdown.parse(markdown) }
    val type = MaterialTheme.typography
    val colors = MaterialTheme.colorScheme
    val codeBackground = colors.surfaceContainerHighest
    val link = colors.primary
    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            for (block in blocks) {
                when (block) {
                    is MdBlock.Paragraph -> Text(inline(block.text, codeBackground, link), style = type.bodyLarge)
                    is MdBlock.Heading -> Text(
                        inline(block.text, codeBackground, link),
                        style = when (block.level) {
                            1 -> type.titleLarge
                            2 -> type.titleMedium
                            else -> type.titleSmall
                        },
                    )
                    is MdBlock.ListItem -> Row(Modifier.padding(start = Spacing.m * block.depth)) {
                        Text(block.marker, style = type.bodyLarge, modifier = Modifier.padding(end = Spacing.s))
                        Text(inline(block.text, codeBackground, link), style = type.bodyLarge)
                    }
                    is MdBlock.Quote -> Surface(
                        color = colors.surfaceContainerHigh,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            inline(block.text, codeBackground, link),
                            style = type.bodyLarge.copy(fontStyle = FontStyle.Italic),
                            color = colors.onSurfaceVariant,
                            modifier = Modifier.padding(Spacing.s),
                        )
                    }
                    is MdBlock.Code -> CodeBlock(block.code)
                    MdBlock.Rule -> HorizontalDivider()
                }
            }
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

private fun inline(text: String, codeBackground: Color, link: Color): AnnotatedString = buildAnnotatedString {
    fun append(spans: List<MdSpan>) {
        for (span in spans) {
            when (span) {
                is MdSpan.Plain -> append(span.text)
                is MdSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(span.spans) }
                is MdSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.spans) }
                is MdSpan.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(span.text) }
                // Only web and mail links open; an agent's text decides nothing else on the phone.
                is MdSpan.Link -> if (!span.url.isSafeLink()) append(span.text) else withLink(
                    LinkAnnotation.Url(
                        span.url,
                        TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)),
                    ),
                ) { append(span.text) }
            }
        }
    }
    append(Markdown.inline(text))
}

private fun String.isSafeLink() = listOf("https://", "http://", "mailto:").any { startsWith(it, ignoreCase = true) }
