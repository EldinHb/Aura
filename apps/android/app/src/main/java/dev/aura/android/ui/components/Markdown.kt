package dev.aura.android.ui.components

/**
 * A small Markdown reader for agent messages: the blocks agents actually
 * write (paragraphs, headings, lists, quotes, fenced code, rules) and inline
 * bold, italic, code and links. Anything else reads as plain text.
 */
sealed interface MdBlock {
    data class Paragraph(val text: String) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Code(val language: String?, val code: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class ListItem(val ordered: Boolean, val marker: String, val depth: Int, val text: String) : MdBlock
    data object Rule : MdBlock
}

sealed interface MdSpan {
    data class Plain(val text: String) : MdSpan
    data class Bold(val spans: List<MdSpan>) : MdSpan
    data class Italic(val spans: List<MdSpan>) : MdSpan
    data class Code(val text: String) : MdSpan
    data class Link(val text: String, val url: String) : MdSpan
}

object Markdown {
    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
    private val BULLET = Regex("^(\\s*)([-*+])\\s+(.*)$")
    private val ORDERED = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
    private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
    private val FENCE = Regex("^\\s{0,3}(```+|~~~+)\\s*([\\w+#.-]*).*$")

    fun parse(text: String): List<MdBlock> {
        val lines = text.replace("\r\n", "\n").split('\n')
        val blocks = mutableListOf<MdBlock>()
        val paragraph = mutableListOf<String>()
        fun flush() {
            if (paragraph.isNotEmpty()) blocks += MdBlock.Paragraph(paragraph.joinToString("\n"))
            paragraph.clear()
        }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val fence = FENCE.matchEntire(line)
            when {
                fence != null -> {
                    flush()
                    val marker = fence.groupValues[1]
                    val body = mutableListOf<String>()
                    i++
                    while (i < lines.size && !lines[i].trimStart().startsWith(marker)) body += lines[i++]
                    blocks += MdBlock.Code(fence.groupValues[2].ifEmpty { null }, body.joinToString("\n"))
                }
                line.isBlank() -> flush()
                RULE.matches(line) -> { flush(); blocks += MdBlock.Rule }
                HEADING.matchEntire(line) != null -> {
                    flush()
                    val m = HEADING.matchEntire(line)!!
                    blocks += MdBlock.Heading(m.groupValues[1].length, m.groupValues[2].trimEnd('#', ' '))
                }
                BULLET.matchEntire(line) != null -> {
                    flush()
                    val m = BULLET.matchEntire(line)!!
                    blocks += MdBlock.ListItem(false, "•", m.groupValues[1].length / 2, m.groupValues[3])
                }
                ORDERED.matchEntire(line) != null -> {
                    flush()
                    val m = ORDERED.matchEntire(line)!!
                    blocks += MdBlock.ListItem(true, m.groupValues[2] + ".", m.groupValues[1].length / 2, m.groupValues[3])
                }
                line.trimStart().startsWith(">") -> {
                    flush()
                    val quote = mutableListOf<String>()
                    while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                        quote += lines[i].trimStart().removePrefix(">").removePrefix(" ")
                        i++
                    }
                    blocks += MdBlock.Quote(quote.joinToString("\n"))
                    continue
                }
                else -> {
                    // A line that continues the list item above it.
                    val last = blocks.lastOrNull()
                    if (paragraph.isEmpty() && last is MdBlock.ListItem && line.startsWith("  ")) {
                        blocks[blocks.lastIndex] = last.copy(text = last.text + " " + line.trim())
                    } else {
                        paragraph += line
                    }
                }
            }
            i++
        }
        flush()
        return blocks
    }

    fun inline(text: String): List<MdSpan> = InlineParser(text).parse(null)

    private class InlineParser(val s: String) {
        var i = 0

        fun parse(until: String?): List<MdSpan> {
            val out = mutableListOf<MdSpan>()
            val plain = StringBuilder()
            fun flush() {
                if (plain.isNotEmpty()) out += MdSpan.Plain(plain.toString())
                plain.clear()
            }
            while (i < s.length) {
                if (until != null && s.startsWith(until, i)) {
                    flush()
                    return out
                }
                val c = s[i]
                when {
                    c == '\\' && i + 1 < s.length && s[i + 1] in "\\`*_[]()#+-.!>" -> {
                        plain.append(s[i + 1]); i += 2
                    }
                    c == '`' -> {
                        val end = s.indexOf('`', i + 1)
                        if (end > i) {
                            flush(); out += MdSpan.Code(s.substring(i + 1, end)); i = end + 1
                        } else {
                            plain.append(c); i++
                        }
                    }
                    (s.startsWith("**", i) || s.startsWith("__", i)) && closes(s.substring(i, i + 2), i + 2) -> {
                        val marker = s.substring(i, i + 2)
                        flush(); i += 2
                        out += MdSpan.Bold(parse(marker)); i = (i + 2).coerceAtMost(s.length)
                    }
                    (c == '*' || (c == '_' && (i == 0 || !s[i - 1].isLetterOrDigit()))) &&
                        i + 1 < s.length && !s[i + 1].isWhitespace() && closes(c.toString(), i + 1) -> {
                        flush(); i++
                        out += MdSpan.Italic(parse(c.toString())); i = (i + 1).coerceAtMost(s.length)
                    }
                    c == '[' -> {
                        val close = s.indexOf("](", i)
                        val end = if (close > i) s.indexOf(')', close + 2) else -1
                        if (close > i && end > close && '\n' !in s.substring(i, end)) {
                            flush()
                            out += MdSpan.Link(s.substring(i + 1, close), s.substring(close + 2, end).trim())
                            i = end + 1
                        } else {
                            plain.append(c); i++
                        }
                    }
                    else -> { plain.append(c); i++ }
                }
            }
            flush()
            return out
        }

        /** Whether [marker] closes somewhere after [from] on this text, not right after an opening space. */
        private fun closes(marker: String, from: Int): Boolean {
            val end = s.indexOf(marker, from)
            return end > from && !s[end - 1].isWhitespace()
        }
    }
}
