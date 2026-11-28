package dev.aura.android.diff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UnifiedDiffTest {
    private val diff = """
        diff --git a/src/app.kt b/src/app.kt
        index 1111111..2222222 100644
        --- a/src/app.kt
        +++ b/src/app.kt
        @@ -10,4 +10,5 @@ fun main() {
             val a = 1
        -    val b = 2
        +    val b = 3
        +    val c = 4
             println(a)
        \ No newline at end of file
        diff --git a/new.txt b/new.txt
        new file mode 100644
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1,2 @@
        +hello
        +world
        diff --git a/logo.png b/logo.png
        Binary files a/logo.png and b/logo.png differ
        diff --git a/gone.txt b/gone.txt
        deleted file mode 100644
        --- a/gone.txt
        +++ /dev/null
        @@ -1 +0,0 @@
        -bye
    """.trimIndent()

    @Test
    fun `files, counts and line numbers are read from a git diff`() {
        val files = parseUnifiedDiff(diff)
        assertEquals(listOf("src/app.kt", "new.txt", "logo.png", "gone.txt"), files.map { it.path })
        val app = files[0]
        assertEquals(2 to 1, app.added to app.removed)
        val lines = app.lines.filter { it.kind != DiffLine.Kind.Hunk && it.kind != DiffLine.Kind.Note }
        assertEquals(listOf(10, 11, 11, 12, 13), lines.map { it.line })
        assertEquals(DiffLine.Kind.Removed, lines[1].kind)
        assertEquals("    val b = 2", lines[1].text)
        assertTrue(app.lines.last().kind == DiffLine.Kind.Note)
        assertTrue(files[1].isNew)
        assertEquals(2, files[1].added)
        assertTrue(files[2].binary)
        assertTrue(files[3].deleted)
        assertEquals("gone.txt", files[3].path)
    }

    @Test
    fun `a reference names the file and the line`() {
        val app = parseUnifiedDiff(diff)[0]
        val added = app.lines.first { it.kind == DiffLine.Kind.Added }
        assertEquals("src/app.kt:11", reference(app, added))
        assertEquals("src/app.kt", reference(app, null))
    }

    @Test
    fun `an empty diff has no files`() {
        assertEquals(emptyList<DiffFile>(), parseUnifiedDiff(""))
    }
}
