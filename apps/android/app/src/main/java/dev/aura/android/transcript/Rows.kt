package dev.aura.android.transcript

import dev.aura.android.protocol.Item
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What the transcript shows, row by row. */
sealed interface Row {
    val key: String

    data class User(val item: Item) : Row { override val key get() = item.id }
    data class Agent(val item: Item) : Row { override val key get() = item.id }
    data class Problem(val item: Item) : Row { override val key get() = item.id }

    /** Steps the agent took between messages (tools, commands, edits, thinking), shown collapsed. */
    data class Work(val items: List<Item>) : Row {
        override val key get() = "work:" + items.first().id
        val running: Boolean get() = items.any { it.status == "in_progress" }
    }
}

/** [items] as rows: consecutive steps are folded into one [Row.Work]. */
fun rows(items: List<Item>): List<Row> {
    val out = mutableListOf<Row>()
    val work = mutableListOf<Item>()
    fun flush() {
        if (work.isNotEmpty()) out += Row.Work(work.toList())
        work.clear()
    }
    for (item in items) {
        when (item.kind) {
            "user_message" -> { flush(); out += Row.User(item) }
            "agent_message" -> { flush(); out += Row.Agent(item) }
            "error" -> { flush(); out += Row.Problem(item) }
            else -> work += item
        }
    }
    flush()
    return out
}

/** A one-line label for a step. */
fun Item.stepLabel(): String {
    title?.takeIf { it.isNotBlank() }?.let { return it }
    return when (kind) {
        "command_exec" -> data.str("command")?.let { "Ran $it" } ?: "Ran a command"
        "file_change" -> (data["changes"] as? JsonArray)?.let { changes ->
            val paths = changes.mapNotNull { ((it as? JsonObject)?.get("path") as? JsonPrimitive)?.contentOrNull }
            "Edited " + paths.joinToString(", ") { it.substringAfterLast('/') }
        } ?: "Edited files"
        "tool_call" -> data.str("tool_name") ?: "Used a tool"
        "mcp_call" -> listOfNotNull(data.str("server"), data.str("tool")).joinToString(" · ").ifEmpty { "Used a tool" }
        "web_search" -> data.str("query")?.let { "Searched the web for $it" } ?: "Searched the web"
        "subagent" -> data.str("description") ?: "Ran a subagent"
        "reasoning" -> "Thought"
        "plan" -> "Updated the plan"
        "system" -> data.str("message") ?: text.ifBlank { "System" }
        else -> kind.replace('_', ' ')
    }
}

/** The step's details, as monospace text: command output, a tool's result, the reasoning. */
fun Item.stepDetail(): String? {
    val detail = when (kind) {
        "command_exec" -> data.str("output")
        "reasoning", "plan" -> text
        "tool_call", "mcp_call" -> data["result"]?.let { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() }
        else -> text
    }
    return detail?.trim()?.takeIf { it.isNotEmpty() }
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
