package dev.aura.android.transcript

import dev.aura.android.protocol.Item
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Ends the first line of every message Aura, not the user, sends an agent (aura-core's `prompts::AURA_MARK`). */
private const val AURA_MARK = "This message comes from Aura, not the user."
private const val AURA_PREFIX = "[Aura] "

/**
 * A message Aura sent an agent in the user's place: a worker report, the
 * user's decision for a feature owner, a teammate's question. Told apart by its
 * first line, `[Aura] <title>. This message comes from Aura, not the user.`, as
 * the desktop does (`lib/auraMessage.ts`): there is no flag on the item.
 */
data class AuraMessage(val title: String, val body: String) {
    companion object {
        /** The Aura message [item] is, or null for anything the user wrote. */
        fun of(item: Item): AuraMessage? {
            if (item.kind != "user_message" || !item.text.startsWith(AURA_PREFIX)) return null
            val end = item.text.indexOf('\n')
            val first = if (end < 0) item.text else item.text.substring(0, end)
            if (!first.endsWith(AURA_MARK)) return null
            val title = first.removePrefix(AURA_PREFIX).removeSuffix(AURA_MARK).trim().removeSuffix(".")
            return AuraMessage(title, if (end < 0) "" else item.text.substring(end + 1).trim())
        }
    }
}

/** A card a feature owner's chat shows from its feature record (aura-core's `features::card_data`). */
data class FeatureCardRef(val kind: String, val id: String) {
    companion object {
        private val KINDS = setOf("decision", "report", "suggestion", "meeting", "role_suggestion")

        /** The card [item] stands for: a `system` item with `data.feature_card {kind, id}`. */
        fun of(item: Item): FeatureCardRef? {
            if (item.kind != "system") return null
            val card = item.data["feature_card"] as? JsonObject ?: return null
            val kind = (card["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
            val id = (card["id"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
            return if (kind in KINDS) FeatureCardRef(kind, id) else null
        }
    }
}
