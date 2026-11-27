package dev.aura.android.transcript

import dev.aura.android.protocol.Approval
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.Item
import dev.aura.android.protocol.UserInputRequest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * One session's transcript, built by replaying its events: the items in the
 * order they started, and what waits for the user.
 */
data class Transcript(
    val order: List<String> = emptyList(),
    val items: Map<String, Item> = emptyMap(),
    val approvals: List<Approval> = emptyList(),
    val inputs: List<UserInputRequest> = emptyList(),
    val turnRunning: Boolean = false,
    val lastError: String? = null,
) {
    /** Items in order. Items a subagent produced are left out: their parent stands for them. */
    val visibleItems: List<Item>
        get() = order.mapNotNull { items[it] }.filter { it.parentId == null }

    fun apply(event: Event): Transcript = when (event) {
        is Event.TurnStarted -> copy(turnRunning = true, lastError = null)
        is Event.TurnCompleted -> copy(turnRunning = false, lastError = event.turn.error)
        is Event.ItemStarted -> {
            val existing = items[event.item.id]
            val merged = existing?.let {
                event.item.copy(text = it.text.ifEmpty { event.item.text }, data = JsonObject(event.item.data + it.data))
            } ?: event.item
            put(merged)
        }
        is Event.ItemCompleted -> put(event.item)
        is Event.ItemDelta -> items[event.itemId]?.let { put(it.applyDelta(event.delta)) } ?: this
        is Event.ApprovalRequested -> copy(approvals = approvals.filterNot { it.id == event.approval.id } + event.approval)
        is Event.ApprovalResolved -> copy(approvals = approvals.filterNot { it.id == event.approvalId })
        is Event.InputRequested -> copy(inputs = inputs.filterNot { it.id == event.request.id } + event.request)
        is Event.InputResolved -> copy(inputs = inputs.filterNot { it.id == event.requestId })
        else -> this
    }

    private fun put(item: Item): Transcript = copy(
        items = items + (item.id to item),
        order = if (item.id in items) order else order + item.id,
    )

    companion object {
        fun of(events: List<Event>): Transcript = events.fold(Transcript()) { t, e -> t.apply(e) }
    }
}

internal fun Item.applyDelta(delta: Event.Delta): Item = when (delta) {
    is Event.Delta.Text -> copy(text = text + delta.text)
    is Event.Delta.Output -> {
        val previous = (data["output"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        copy(data = JsonObject(data + ("output" to JsonPrimitive(previous + delta.text))))
    }
    is Event.Delta.Data -> copy(data = JsonObject(data + delta.data))
}
