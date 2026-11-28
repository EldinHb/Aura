package dev.aura.android.images

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * An image sent with a message, as the daemon takes it (`ImageInput`): base64
 * data by value (a path is refused from a phone), a small `data:` thumbnail
 * the transcript shows, and the size sent next to the size it had.
 */
@Serializable
data class ImageInput(
    val data: String,
    @SerialName("media_type") val mediaType: String,
    val name: String? = null,
    val thumbnail: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    @SerialName("original_width") val originalWidth: Int? = null,
    @SerialName("original_height") val originalHeight: Int? = null,
)

/** What an agent takes per image (the desktop's `imageLimits`): the longest side, and the base64 length. */
data class ImageLimits(val maxEdge: Int, val maxBase64: Int) {
    companion object {
        /** Claude Code, ACP agents: 2000 px once a request holds many images, 5 MB on some clouds. */
        val STRICTEST = ImageLimits(2000, 5_000_000)

        fun forProvider(provider: String?): ImageLimits = if (provider == "codex") ImageLimits(2048, 10_000_000) else STRICTEST
    }
}

/** Length of the base64 text for [bytes] bytes, which is what the limits count. */
fun base64Length(bytes: Int): Int = 4 * ((bytes + 2) / 3)

/** The largest size within [maxEdge] on both sides that keeps the aspect ratio; never larger than it was. */
fun fitDimensions(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
    val scale = minOf(1.0, maxEdge.toDouble() / max(width, height))
    return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
}

/** An image a sent message shows: its thumbnail and, to see it whole, the attachment the daemon kept. */
data class MessageImage(
    val key: String,
    val name: String?,
    val thumbnail: String?,
    val attachment: String?,
    val resized: Boolean,
)

/** The images of a user message's `data`, as the desktop reads them (`data.attachments`, or Codex's echoed content). */
fun messageImages(data: JsonObject): List<MessageImage> {
    fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.intOrNull
    (data["attachments"] as? JsonArray)?.let { list ->
        return list.mapIndexedNotNull { i, a ->
            val o = a as? JsonObject ?: return@mapIndexedNotNull null
            MessageImage(
                key = o.str("id") ?: "a$i",
                name = o.str("name"),
                thumbnail = o.str("thumbnail")?.takeIf { it.startsWith("data:image/") },
                attachment = o.str("id"),
                resized = o.int("original_width") != null && o.int("original_height") != null,
            )
        }
    }
    (data["content"] as? JsonArray)?.let { parts ->
        return parts.mapIndexedNotNull { i, c ->
            val o = c as? JsonObject ?: return@mapIndexedNotNull null
            val url = o.str("url") ?: o.str("image_url")
            if (o.str("type") == "image" && url?.startsWith("data:image/") == true) MessageImage("c$i", null, url, null, false) else null
        }
    }
    return emptyList()
}
