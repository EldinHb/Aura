package dev.aura.android.transcript

import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Pending
import dev.aura.android.protocol.StoredEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** How many stored events `session.history` is asked for at a time. */
const val HISTORY_PAGE = 5000

/**
 * A session's whole stored history, a page at a time: [page] is
 * `session.history {id, after_seq, limit}`; the next page starts after the
 * last seq of the one before, until a page comes back short.
 */
suspend fun fetchHistory(limit: Int = HISTORY_PAGE, page: suspend (afterSeq: Long, limit: Int) -> List<StoredEvent>): List<StoredEvent> {
    val all = mutableListOf<StoredEvent>()
    var after = 0L
    while (true) {
        val events = page(after, limit)
        all += events
        val last = events.lastOrNull()?.seq ?: break
        if (events.size < limit || last <= after) break
        after = last
    }
    return all
}

// Events the daemon never stores (aura-core's Event::is_persistent): they
// reach a client live only.
private val NOT_STORED = setOf(
    "session_created", "session_updated", "session_removed", "item_delta",
    "feature_updated", "specialist_suggestions_updated", "workspaces_changed",
)

private val JsonObject.stored: Boolean
    get() = (this["type"] as? JsonPrimitive)?.contentOrNull !in NOT_STORED

/**
 * The transcript from a session's [history], what [pending] says waits on the
 * user, and the [live] events (as received) that came while those loaded.
 *
 * The daemon stores an event before it sends it, so the first live events may
 * already be at the end of the history: the longest run of stored live events
 * that the history ends with is skipped, the rest applied. Text deltas are
 * never stored, so each live one is new; one for an item the history already
 * has finished is dropped by [Transcript.apply].
 */
fun reconcile(history: List<StoredEvent>, pending: Pending, sessionId: String, live: List<JsonObject>): Transcript {
    val stored = history.map { it.event }
    val liveStored = live.filter { it.stored }
    val overlap = (minOf(stored.size, liveStored.size) downTo 0).first { k ->
        (0 until k).all { i -> liveStored[i] == stored[stored.size - k + i] }
    }
    var t = Transcript.of(stored.mapNotNull(Event::parse)).copy(
        approvals = pending.approvals.filter { it.sessionId == sessionId },
        inputs = pending.inputs.filter { it.sessionId == sessionId },
    )
    var skip = overlap
    for (raw in live) {
        if (raw.stored && skip > 0) {
            skip--
            continue
        }
        Event.parse(raw)?.let { t = t.apply(it) }
    }
    return t
}
