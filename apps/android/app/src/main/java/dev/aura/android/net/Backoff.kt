package dev.aura.android.net

import kotlin.math.min
import kotlin.random.Random

/** How long to wait before reconnect attempt [attempt] (1 is the first retry): doubling from 1 s to 30 s, with jitter. */
fun backoffMillis(attempt: Int, random: Random = Random.Default): Long {
    val base = 1_000L shl min(attempt.coerceAtLeast(1) - 1, 5)
    val capped = min(base, 30_000L)
    val jitter = (capped * 0.2 * (random.nextDouble() * 2 - 1)).toLong()
    return capped + jitter
}
