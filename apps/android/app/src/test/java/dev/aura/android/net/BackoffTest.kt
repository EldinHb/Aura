package dev.aura.android.net

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {
    @Test
    fun `waits double from one second and stop at thirty, give or take a fifth`() {
        val expected = mapOf(1 to 1_000L, 2 to 2_000L, 3 to 4_000L, 4 to 8_000L, 5 to 16_000L, 6 to 30_000L, 50 to 30_000L)
        for ((attempt, base) in expected) {
            repeat(50) {
                val wait = backoffMillis(attempt, Random(it))
                assertTrue("attempt $attempt waited $wait", wait in (base * 0.8).toLong()..(base * 1.2).toLong())
            }
        }
        assertTrue(backoffMillis(0) in 800L..1_200L)
    }
}
