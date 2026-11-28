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

/** What [this] adds to a message: its base64 and its thumbnail's. */
val ImageInput.byteCount: Int get() = data.length + (thumbnail?.length ?: 0)

/** At most this many images go with one message. */
const val MAX_IMAGES = 10

/**
 * At most this much base64 (images and their thumbnails) goes with one
 * message: the remote listener takes messages up to 16 MB, JSON included.
 */
const val MAX_MESSAGE_IMAGE_BYTES = 15_000_000

/** An image file larger than this is not read. */
const val MAX_SOURCE_BYTES = 50 * 1024 * 1024

/** The most pixels an image is decoded to (4096 × 4096, 64 MB as ARGB). */
const val MAX_DECODED_PIXELS = 4096L * 4096L

/**
 * The power of two to decode a [width] × [height] image at: the largest that
 * still leaves its longest side at least [maxEdge] (the size it is shrunk to
 * after), and then larger until it decodes to at most [maxPixels]. Going by
 * the longest side, a very long thin image is sampled down too.
 */
fun sampleSize(width: Int, height: Int, maxEdge: Int, maxPixels: Long = MAX_DECODED_PIXELS): Int {
    val longest = max(width, height)
    var sample = 1
    while (sample < MAX_SAMPLE && longest / (sample * 2) >= maxEdge) sample *= 2
    while (sample < MAX_SAMPLE && decodedPixels(width, height, sample) > maxPixels) sample *= 2
    return sample
}

/** How many pixels a [width] × [height] image decodes to at [sample]. */
fun decodedPixels(width: Int, height: Int, sample: Int): Long =
    ((width + sample - 1) / sample).toLong() * ((height + sample - 1) / sample).toLong()

private const val MAX_SAMPLE = 1 shl 30

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
