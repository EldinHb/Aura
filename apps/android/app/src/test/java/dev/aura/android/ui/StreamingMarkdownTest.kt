package dev.aura.android.ui

import dev.aura.android.ui.components.closeOpenFence
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingMarkdownTest {
    @Test
    fun `an open code fence is closed while the reply streams`() {
        assertEquals("Text\n```kotlin\nval x = 1\n```", closeOpenFence("Text\n```kotlin\nval x = 1\n"))
        assertEquals("~~~\ncode\n~~~", closeOpenFence("~~~\ncode"))
        assertEquals("````\na ``` b\n````", closeOpenFence("````\na ``` b"))
    }

    @Test
    fun `a fence still arriving is not shown as text`() {
        assertEquals("Text", closeOpenFence("Text\n`"))
        assertEquals("```\ncode\n```", closeOpenFence("```\ncode\n``"))
        assertEquals("Use `x` here", closeOpenFence("Use `x` here"))
    }

    @Test
    fun `closed fences and plain text are left as they are`() {
        val closed = "```\ncode\n```\nafter"
        assertEquals(closed, closeOpenFence(closed))
        assertEquals("No code here", closeOpenFence("No code here"))
        assertEquals("```\none\n```\n```\ntwo\n```", closeOpenFence("```\none\n```\n```\ntwo"))
    }
}
