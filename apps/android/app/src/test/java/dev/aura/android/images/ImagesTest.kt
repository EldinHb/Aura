package dev.aura.android.images

import dev.aura.android.net.ProtocolJson
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImagesTest {
    @Test
    fun `images fit the agent's longest side, never grow, keep their shape`() {
        assertEquals(2000 to 1500, fitDimensions(4000, 3000, 2000))
        assertEquals(1125 to 2000, fitDimensions(2250, 4000, 2000))
        assertEquals(800 to 600, fitDimensions(800, 600, 2000))
        assertEquals(1 to 2000, fitDimensions(1, 10_000, 2000))
    }

    @Test
    fun `limits are the desktop's per provider and count base64 length`() {
        assertEquals(ImageLimits(2048, 10_000_000), ImageLimits.forProvider("codex"))
        assertEquals(ImageLimits(2000, 5_000_000), ImageLimits.forProvider("claude"))
        assertEquals(ImageLimits.STRICTEST, ImageLimits.forProvider("acp"))
        assertEquals(4, base64Length(1))
        assertEquals(4, base64Length(3))
        assertEquals(8, base64Length(4))
    }

    @Test
    fun `a sent message's images are read from its attachments`() {
        val data = ProtocolJson.parseToJsonElement(
            """{"attachments":[{"id":"att1","name":"shot.png","thumbnail":"data:image/jpeg;base64,AAAA","original_width":4000,"original_height":3000},
               {"id":"att2","thumbnail":"https://evil"},"junk"]}""",
        ).jsonObject
        val images = messageImages(data)
        assertEquals(listOf("att1", "att2"), images.map { it.attachment })
        assertTrue(images[0].resized)
        assertEquals("shot.png", images[0].name)
        assertNull("only data: thumbnails are shown", images[1].thumbnail)
        assertFalse(images[1].resized)
    }

    @Test
    fun `codex's echoed inline images are read too, and nothing else`() {
        val data = ProtocolJson.parseToJsonElement("""{"content":[{"type":"image","url":"data:image/png;base64,AA"},{"type":"text","text":"hi"}]}""").jsonObject
        assertEquals(listOf("data:image/png;base64,AA"), messageImages(data).map { it.thumbnail })
        assertTrue(messageImages(ProtocolJson.parseToJsonElement("{}").jsonObject).isEmpty())
    }

    @Test
    fun `a very long thin image is sampled by its longest side`() {
        val sample = sampleSize(100_000_000, 1, 2000)
        assertEquals(32_768, sample)
        assertTrue(decodedPixels(100_000_000, 1, sample) <= 2 * 2000)
        assertEquals(32_768, sampleSize(1, 100_000_000, 2000))
    }

    @Test
    fun `the sample keeps the longest side at least the target`() {
        assertEquals(1, sampleSize(1000, 800, 2000))
        assertEquals(1, sampleSize(3999, 3000, 2000))
        assertEquals(2, sampleSize(4000, 3000, 2000))
        assertEquals(4, sampleSize(12_000, 9_000, 2000))
        // At least 2000 left on the longest side, under 4000.
        for (w in listOf(2000, 2001, 5000, 8191, 8192, 50_000)) {
            val longest = (w + sampleSize(w, 10, 2000) - 1) / sampleSize(w, 10, 2000)
            assertTrue("$w → $longest", longest in 2000 until 4000)
        }
    }

    @Test
    fun `the decoded pixels stay within the budget`() {
        // Square and huge: the longest side alone would leave a 2048-4096 square; a smaller budget still holds.
        val sample = sampleSize(65_536, 65_536, 2000, maxPixels = 1_000_000)
        assertTrue(decodedPixels(65_536, 65_536, sample) <= 1_000_000)
        for ((w, h) in listOf(46_000 to 46_000, 100_000 to 30_000, Int.MAX_VALUE to Int.MAX_VALUE)) {
            assertTrue("$w x $h", decodedPixels(w, h, sampleSize(w, h, 2048)) <= MAX_DECODED_PIXELS)
        }
    }

    @Test
    fun `an image's size in a message counts its thumbnail`() {
        assertEquals(7, ImageInput(data = "abcd", mediaType = "image/png", thumbnail = "xyz").byteCount)
        assertEquals(4, ImageInput(data = "abcd", mediaType = "image/png").byteCount)
    }
}
