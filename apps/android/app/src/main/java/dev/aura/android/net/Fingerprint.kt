package dev.aura.android.net

import java.security.MessageDigest
import java.security.cert.Certificate

/** SHA-256 fingerprints of certificates, as lowercase hex without separators. */
object Fingerprint {
    private val HEX = Regex("^[0-9a-f]{64}$")

    /** The fingerprint of [cert]'s DER encoding. */
    fun of(cert: Certificate): String = of(cert.encoded)

    fun of(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /**
     * [text] as a fingerprint: case, colons and whitespace are ignored, as
     * fingerprints are often written `AB:CD:..`. Null when it is not 32 bytes of hex.
     */
    fun normalize(text: String): String? {
        val hex = text.filterNot { it == ':' || it.isWhitespace() }.lowercase()
        return hex.takeIf { HEX.matches(it) }
    }

    /** [fp] in groups of four, for reading aloud or comparing by eye. */
    fun grouped(fp: String): String = fp.chunked(4).joinToString(" ")
}
