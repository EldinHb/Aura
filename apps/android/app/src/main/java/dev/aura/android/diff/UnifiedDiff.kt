package dev.aura.android.diff

/** One line of a diff: added, removed or context, with its number in the old and new file. */
data class DiffLine(val kind: Kind, val text: String, val oldLine: Int?, val newLine: Int?) {
    enum class Kind { Added, Removed, Context, Hunk, Note }

    /** The line a reference points at: in the new file, or in the old one for a removed line. */
    val line: Int? get() = newLine ?: oldLine
}

/** One file of a diff. */
data class DiffFile(
    val path: String,
    val oldPath: String?,
    val lines: List<DiffLine>,
    val added: Int,
    val removed: Int,
    val binary: Boolean = false,
    val isNew: Boolean = false,
    val deleted: Boolean = false,
)

/** `@@ -12,7 +12,9 @@`: where a hunk starts in the old and new file. */
private val HUNK = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")

/**
 * A `git diff` (unified, untracked files appended as `/dev/null` diffs) as
 * files with numbered lines. What it does not recognise is kept as a note,
 * so nothing of the diff is lost.
 */
fun parseUnifiedDiff(text: String): List<DiffFile> {
    val files = mutableListOf<DiffFile>()
    var path: String? = null
    var oldPath: String? = null
    var lines = mutableListOf<DiffLine>()
    var added = 0
    var removed = 0
    var binary = false
    var isNew = false
    var deleted = false
    var oldNo = 0
    var newNo = 0
    var inHunk = false
    fun flush() {
        path?.let { files += DiffFile(it, oldPath?.takeIf { o -> o != it }, lines, added, removed, binary, isNew, deleted) }
        path = null; oldPath = null; lines = mutableListOf(); added = 0; removed = 0
        binary = false; isNew = false; deleted = false; inHunk = false
    }
    for (raw in text.lineSequence()) {
        when {
            raw.startsWith("diff --git ") -> {
                flush()
                // `diff --git a/x b/y`: the paths, until the --- / +++ lines say better.
                val rest = raw.removePrefix("diff --git ")
                val b = rest.lastIndexOf(" b/")
                path = if (b >= 0) rest.substring(b + 3) else rest
                oldPath = rest.substringBefore(" b/").removePrefix("a/")
            }
            !inHunk && raw.startsWith("--- ") -> {
                val p = raw.removePrefix("--- ")
                if (p == "/dev/null") isNew = true else oldPath = p.removePrefix("a/")
            }
            !inHunk && raw.startsWith("+++ ") -> {
                val p = raw.removePrefix("+++ ")
                if (p == "/dev/null") deleted = true else path = p.removePrefix("b/")
                if (path == null) path = oldPath
            }
            !inHunk && raw.startsWith("new file mode") -> isNew = true
            !inHunk && raw.startsWith("deleted file mode") -> deleted = true
            !inHunk && raw.startsWith("rename to ") -> path = raw.removePrefix("rename to ")
            raw.startsWith("Binary files ") -> { binary = true; lines += DiffLine(DiffLine.Kind.Note, raw, null, null) }
            raw.startsWith("@@") -> {
                val m = HUNK.find(raw)
                oldNo = m?.groupValues?.get(1)?.toInt() ?: 0
                newNo = m?.groupValues?.get(2)?.toInt() ?: 0
                inHunk = true
                lines += DiffLine(DiffLine.Kind.Hunk, raw, null, null)
            }
            inHunk && raw.startsWith("+") -> { lines += DiffLine(DiffLine.Kind.Added, raw.substring(1), null, newNo++); added++ }
            inHunk && raw.startsWith("-") -> { lines += DiffLine(DiffLine.Kind.Removed, raw.substring(1), oldNo++, null); removed++ }
            inHunk && raw.startsWith(" ") -> lines += DiffLine(DiffLine.Kind.Context, raw.substring(1), oldNo++, newNo++)
            inHunk && raw.startsWith("\\") -> lines += DiffLine(DiffLine.Kind.Note, raw, null, null)
            path == null -> {}
            raw.isEmpty() -> {}
            !inHunk -> {} // index, mode and similarity lines
            else -> lines += DiffLine(DiffLine.Kind.Note, raw, null, null)
        }
    }
    flush()
    return files
}

/** What "Ask for changes" puts in the composer for [line] of [file]: `path:line`. */
fun reference(file: DiffFile, line: DiffLine?): String =
    line?.line?.let { "${file.path}:$it" } ?: file.path
