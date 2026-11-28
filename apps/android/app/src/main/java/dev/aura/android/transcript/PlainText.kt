package dev.aura.android.transcript

private val LINK = Regex("!?\\[([^]]*)]\\([^)]*\\)")
private val MARKERS = Regex("[*_`~]+")
private val BLOCK_START = Regex("^\\s*(#{1,6}\\s+|>\\s?|[-*+]\\s+\\[[ xX]]\\s+|[-*+]\\s+|\\d+[.)]\\s+)")
private val RULE_OR_TABLE_LINE = Regex("^[\\s|:\\-]*$")
private val FENCE = Regex("^\\s*(```|~~~)")

/**
 * [markdown] as plain text, line by line, for previews where it cannot be
 * rendered (a one-line summary, a notification): no emphasis, code or
 * heading markers, links as their text, fences and table rules dropped.
 */
fun plainText(markdown: String): String = markdown.lineSequence()
    .filterNot { FENCE.containsMatchIn(it) }
    .map { line ->
        line.replace(BLOCK_START, "")
            .replace(LINK, "$1")
            .replace(MARKERS, "")
            .trim()
    }
    .filterNot { it.isNotEmpty() && RULE_OR_TABLE_LINE.matches(it) }
    .joinToString("\n")
    .replace(Regex("\\n{3,}"), "\n\n")
    .trim()

/** The first line of [markdown] with text in it, as plain text; null when there is none. */
fun firstPlainLine(markdown: String): String? = plainText(markdown).lineSequence().firstOrNull { it.isNotBlank() }
