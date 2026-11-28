package dev.aura.android.transcript

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlainTextTest {
    @Test
    fun `a preview line has no markdown markers`() {
        assertEquals("Step 3 is done. Tests pass; next I look at SessionList.kt.", firstPlainLine("**Step 3** is done. Tests pass; next I look at `SessionList.kt`."))
        assertEquals("Status", firstPlainLine("\n## Status\n\nMore"))
        assertEquals("See the docs, old now", firstPlainLine("See [the docs](https://x.y), ~~old~~ now"))
        assertEquals("Quoted", firstPlainLine("> _Quoted_"))
        assertEquals("Grouped", firstPlainLine("- [x] Grouped"))
        assertNull(firstPlainLine("  \n---\n"))
    }

    @Test
    fun `a whole reply reads as plain text, code kept, fences and table rules dropped`() {
        val md = "## Done\n\n1. **First** step\n2. Second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```kotlin\nval x = 1\n```"
        assertEquals("Done\n\nFirst step\nSecond\n\n| A | B |\n| 1 | 2 |\n\nval x = 1", plainText(md))
    }
}
