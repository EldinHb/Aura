package dev.aura.android.images

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** An image picked for the composer, ready to send, with its thumbnail decoded for showing. */
data class DraftImage(val id: String, val input: ImageInput, val preview: Bitmap)

/**
 * Reads an image from the phone and makes it what an agent takes, as the
 * desktop does: shrunk to [ImageLimits] (and further until it fits the byte
 * limit), JPEG kept JPEG, anything else PNG when that fits and JPEG when not,
 * with a small thumbnail for the transcript. Call it off the main thread.
 */
class ImageEncoder(private val resolver: ContentResolver) {
    fun encode(uri: Uri, limits: ImageLimits): DraftImage {
        // Read once, so the size checked is the image decoded (a provider may answer differently each time).
        val source = read(uri)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
        val type = bounds.outMimeType ?: resolver.getType(uri) ?: "image/jpeg"
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "This file is not an image Aura can read." }
        val (w, h) = fitDimensions(bounds.outWidth, bounds.outHeight, limits.maxEdge)
        // Decoded at a power of two that still covers the target within the pixel budget, then scaled exactly.
        val sample = sampleSize(bounds.outWidth, bounds.outHeight, limits.maxEdge)
        val decoded = BitmapFactory.decodeByteArray(source, 0, source.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: error("This file is not an image Aura can read.")
        check(decoded.width.toLong() * decoded.height <= MAX_DECODED_PIXELS) { "This image is too large." }
        var width = w
        var height = h
        var out: Pair<ByteArray, String>? = null
        for (round in 0 until MAX_ROUNDS) {
            val scaled = decoded.scale(width, height)
            out = formatsFor(type).firstNotNullOfOrNull { (format, mime, quality) ->
                compress(scaled, format, quality).takeIf { base64Length(it.size) <= limits.maxBase64 }?.let { it to mime }
            }
            if (out != null) break
            width = max(1, (width * SHRINK).roundToInt())
            height = max(1, (height * SHRINK).roundToInt())
        }
        val (bytes, mime) = out ?: error("This image cannot be made small enough to send.")
        val thumb = thumbnail(decoded)
        val resized = width != bounds.outWidth || height != bounds.outHeight
        return DraftImage(
            id = uri.toString(),
            input = ImageInput(
                data = Base64.encodeToString(bytes, Base64.NO_WRAP),
                mediaType = mime,
                name = displayName(uri),
                thumbnail = "data:image/jpeg;base64," + Base64.encodeToString(compress(thumb, Bitmap.CompressFormat.JPEG, THUMB_QUALITY), Base64.NO_WRAP),
                width = width,
                height = height,
                originalWidth = if (resized) bounds.outWidth else null,
                originalHeight = if (resized) bounds.outHeight else null,
            ),
            preview = thumb,
        )
    }

    /** The file at [uri], refused when larger than [MAX_SOURCE_BYTES]. */
    private fun read(uri: Uri): ByteArray {
        val input = resolver.openInputStream(uri) ?: error("This file cannot be read.")
        val out = ByteArrayOutputStream()
        input.use {
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = it.read(buffer)
                if (n < 0) break
                check(out.size() + n <= MAX_SOURCE_BYTES) { "This file is too large." }
                out.write(buffer, 0, n)
            }
        }
        return out.toByteArray()
    }

    private fun formatsFor(type: String): List<Triple<Bitmap.CompressFormat, String, Int>> = if (type == "image/jpeg") {
        listOf(Triple(Bitmap.CompressFormat.JPEG, "image/jpeg", 92), Triple(Bitmap.CompressFormat.JPEG, "image/jpeg", 85))
    } else {
        // Screenshots stay lossless when that fits.
        listOf(Triple(Bitmap.CompressFormat.PNG, "image/png", 100), Triple(Bitmap.CompressFormat.JPEG, "image/jpeg", 90), Triple(Bitmap.CompressFormat.JPEG, "image/jpeg", 82))
    }

    private fun compress(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray {
        // JPEG has no transparency: white behind it, as the desktop does.
        val source = if (format == Bitmap.CompressFormat.JPEG && bitmap.hasAlpha()) {
            createBitmap(bitmap.width, bitmap.height).also {
                Canvas(it).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
            }
        } else {
            bitmap
        }
        return ByteArrayOutputStream().also { source.compress(format, quality, it) }.toByteArray()
    }

    private fun thumbnail(bitmap: Bitmap): Bitmap {
        val (w, h) = fitDimensions(bitmap.width, bitmap.height, THUMB_EDGE)
        return bitmap.scale(w, h)
    }

    private fun displayName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()

    private companion object {
        const val MAX_ROUNDS = 8
        const val SHRINK = 0.8
        const val THUMB_EDGE = 192
        const val THUMB_QUALITY = 80
    }
}

/** A `data:image/…;base64,` URL (a thumbnail) or plain base64 decoded to a bitmap; null when it is neither. */
fun decodeImage(dataUrlOrBase64: String): Bitmap? = runCatching {
    val b64 = dataUrlOrBase64.substringAfter("base64,", dataUrlOrBase64)
    val bytes = Base64.decode(b64, Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()
