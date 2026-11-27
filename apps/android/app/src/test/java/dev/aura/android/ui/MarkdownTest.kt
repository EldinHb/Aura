package dev.aura.android.ui

import dev.aura.android.ui.components.Markdown
import dev.aura.android.ui.components.MdBlock
import dev.aura.android.ui.components.MdSpan
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    @Test
    fun `blocks are recognised`() {
        val blocks = Markdown.parse(
            """
            # Title
            Some text
            on two lines.

            - one
              continued
            - two
              - nested
            1. first
            > quoted
            > still
            ---
            ```kotlin
            val x = 1

            val y = 2
            ```
            """.trimIndent(),
        )
        assertEquals(
            listOf(
                MdBlock.Heading(1, "Title"),
                MdBlock.Paragraph("Some text\non two lines."),
                MdBlock.ListItem(false, "•", 0, "one continued"),
                MdBlock.ListItem(false, "•", 0, "two"),
                MdBlock.ListItem(false, "•", 1, "nested"),
                MdBlock.ListItem(true, "1.", 0, "first"),
                MdBlock.Quote("quoted\nstill"),
                MdBlock.Rule,
                MdBlock.Code("kotlin", "val x = 1\n\nval y = 2"),
            ),
            blocks,
        )
    }

    @Test
    fun `an unclosed fence runs to the end`() {
        assertEquals(listOf(MdBlock.Code(null, "a\nb")), Markdown.parse("```\na\nb"))
    }

    @Test
    fun `inline styles nest`() {
        assertEquals(
            listOf(
                MdSpan.Plain("a "),
                MdSpan.Bold(listOf(MdSpan.Plain("bold "), MdSpan.Italic(listOf(MdSpan.Plain("it"))))),
                MdSpan.Plain(" "),
                MdSpan.Code("x*y"),
                MdSpan.Plain(" "),
                MdSpan.Link("docs", "https://aura.dev"),
            ),
            Markdown.inline("a **bold *it*** `x*y` [docs](https://aura.dev)"),
        )
    }

    @Test
    fun `stray markers stay text`() {
        assertEquals(listOf(MdSpan.Plain("2 * 3 = 6, snake_case_name, [x] and `tick")), Markdown.inline("2 * 3 = 6, snake_case_name, [x] and `tick"))
        assertEquals(listOf(MdSpan.Plain("**not closed")), Markdown.inline("**not closed"))
        assertEquals(listOf(MdSpan.Plain("*literal*")), Markdown.inline("\\*literal\\*"))
    }

    @Test
    fun `a marker hidden in a code span does not overrun`() {
        // The closing ** sits inside the code span, which the bold's content consumes.
        Markdown.inline("**a `b**` c")
    }
}
