package dev.aura.android.protocol

import dev.aura.android.net.ProtocolJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/** The daemon's events (`event` notifications and `session.history`) this app acts on. */
sealed interface Event {
    val sessionId: String?

    data class SessionCreated(val session: Session) : Event { override val sessionId get() = session.id }
    data class SessionUpdated(val session: Session) : Event { override val sessionId get() = session.id }
    data class SessionRemoved(override val sessionId: String) : Event
    data class TurnStarted(override val sessionId: String, val turn: Turn) : Event
    data class TurnCompleted(override val sessionId: String, val turn: Turn) : Event
    data class ItemStarted(override val sessionId: String, val item: Item) : Event
    data class ItemCompleted(override val sessionId: String, val item: Item) : Event
    data class ItemDelta(override val sessionId: String, val itemId: String, val delta: Delta) : Event
    data class ApprovalRequested(override val sessionId: String, val approval: Approval) : Event
    data class ApprovalResolved(override val sessionId: String, val approvalId: String) : Event
    data class InputRequested(override val sessionId: String, val request: UserInputRequest) : Event
    data class InputResolved(override val sessionId: String, val requestId: String) : Event
    data class Notice(override val sessionId: String, val level: String, val message: String) : Event
    data class FeatureUpdated(override val sessionId: String, val feature: Feature) : Event
    data class WorkspacesChanged(val workspaces: List<Workspace>) : Event { override val sessionId: String? get() = null }

    /** A change to an item: text appended to it, command output appended, or data fields set. */
    sealed interface Delta {
        data class Text(val text: String) : Delta
        data class Output(val text: String) : Delta
        data class Data(val data: JsonObject) : Delta
    }

    companion object {
        /** [obj] as an event, or null when it is one this app does not act on (or malformed). */
        fun parse(obj: JsonObject): Event? = runCatching { parseOrThrow(obj) }.getOrNull()

        private fun parseOrThrow(o: JsonObject): Event? {
            val sid = { o.string("session_id")!! }
            return when (o.string("type")) {
                "session_created" -> SessionCreated(o.decode("session", Session.serializer()))
                "session_updated" -> SessionUpdated(o.decode("session", Session.serializer()))
                "session_removed" -> SessionRemoved(sid())
                "turn_started" -> TurnStarted(sid(), o.decode("turn", Turn.serializer()))
                "turn_completed" -> TurnCompleted(sid(), o.decode("turn", Turn.serializer()))
                "item_started" -> ItemStarted(sid(), o.decode("item", Item.serializer()))
                "item_completed" -> ItemCompleted(sid(), o.decode("item", Item.serializer()))
                "item_delta" -> {
                    val d = o["delta"]!!.jsonObject
                    val delta = when (d.string("kind")) {
                        "text" -> Delta.Text(d.string("text").orEmpty())
                        "output" -> Delta.Output(d.string("text").orEmpty())
                        "data" -> Delta.Data(d["data"]?.jsonObject ?: JsonObject(emptyMap()))
                        else -> return null
                    }
                    ItemDelta(sid(), o.string("item_id")!!, delta)
                }
                "approval_requested" -> ApprovalRequested(sid(), o.decode("approval", Approval.serializer()))
                "approval_resolved" -> ApprovalResolved(sid(), o.string("approval_id")!!)
                "user_input_requested" -> InputRequested(sid(), o.decode("request", UserInputRequest.serializer()))
                "user_input_resolved" -> InputResolved(sid(), o.string("request_id")!!)
                "workspaces_changed" -> WorkspacesChanged(o.decode("workspaces", ListSerializer(Workspace.serializer())))
                "feature_updated" -> FeatureUpdated(sid(), o.decode("feature", Feature.serializer()))
                "notice" -> Notice(sid(), o.string("level") ?: "info", o.string("message").orEmpty())
                else -> null
            }
        }

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

        private fun <T> JsonObject.decode(key: String, serializer: KSerializer<T>): T =
            ProtocolJson.decodeFromJsonElement(serializer, this[key]!!)
    }
}
