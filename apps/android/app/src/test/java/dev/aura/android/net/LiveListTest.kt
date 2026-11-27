package dev.aura.android.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveListTest {
    private data class Row(val id: String, val at: Int, val text: String = "")

    private val list = LiveList<Row>({ it.id }) { incoming, existing -> incoming.at >= existing.at }

    @Test
    fun `events before the first load are not lost`() {
        list.beginReload()
        list.upsert(Row("b", 5))
        assertNull(list.items.value)
        list.endReload(listOf(Row("a", 1)))
        assertEquals(listOf(Row("a", 1), Row("b", 5)), list.items.value)
    }

    @Test
    fun `a reload does not undo a newer update that came while it was on its way`() {
        list.beginReload()
        list.endReload(listOf(Row("a", 1, "old")))
        list.beginReload()
        list.upsert(Row("a", 3, "new"))
        // The snapshot was taken before the update.
        list.endReload(listOf(Row("a", 2, "snapshot")))
        assertEquals(listOf(Row("a", 3, "new")), list.items.value)
    }

    @Test
    fun `an update older than the reloaded list does not replace it`() {
        list.beginReload()
        list.upsert(Row("a", 1, "stale"))
        list.endReload(listOf(Row("a", 4, "snapshot")))
        assertEquals(listOf(Row("a", 4, "snapshot")), list.items.value)
    }

    @Test
    fun `a removal during a reload stays removed`() {
        list.beginReload()
        list.remove("a")
        list.endReload(listOf(Row("a", 1), Row("b", 1)))
        assertEquals(listOf(Row("b", 1)), list.items.value)
    }

    @Test
    fun `a failed reload keeps the list, and later updates apply directly`() {
        list.beginReload()
        list.endReload(listOf(Row("a", 1)))
        list.beginReload()
        list.endReload(null)
        assertEquals(listOf(Row("a", 1)), list.items.value)
        list.upsert(Row("a", 0, "live"))
        assertEquals("live events outside a reload are the newest", listOf(Row("a", 0, "live")), list.items.value)
    }

    @Test
    fun `overlapping reloads keep the changes until the last ends`() {
        list.beginReload()
        list.beginReload()
        list.upsert(Row("x", 9))
        list.endReload(listOf(Row("a", 1)))
        list.endReload(listOf(Row("a", 2)))
        assertEquals(listOf(Row("a", 2), Row("x", 9)), list.items.value)
    }
}
