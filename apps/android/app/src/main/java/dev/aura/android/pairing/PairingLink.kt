package dev.aura.android.pairing

import dev.aura.android.net.Fingerprint
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * What a pairing link carries: where the server listens, the SHA-256 of its
 * certificate, and the one-time code that pairs this device.
 *
 * The link is `aura://pair?host=..&port=..&fp=..&code=..&name=..`; `name`
 * is optional.
 */
data class PairingLink(
    val host: String,
    val port: Int,
    val fingerprint: String,
    val code: String,
    val name: String?,
) {
    companion object {
        const val SCHEME = "aura"
        const val HOST = "pair"

        /** Parses [text] (whitespace around it is ignored), or says why it is not a pairing link. */
        fun parse(text: String): Result<PairingLink> {
            val uri = try {
                URI(text.trim())
            } catch (e: URISyntaxException) {
                return failure("This is not a link.")
            }
            if (!uri.scheme.equals(SCHEME, ignoreCase = true) || !uri.authority.equals(HOST, ignoreCase = true)) {
                return failure("This is not an Aura pairing link: it should start with aura://pair.")
            }
            val query = parseQuery(uri.rawQuery.orEmpty())
            return of(
                host = query["host"].orEmpty(),
                port = query["port"].orEmpty(),
                fingerprint = query["fp"].orEmpty(),
                code = query["code"].orEmpty(),
                name = query["name"],
            )
        }

        /** Checks the fields of a link or of manual entry, and normalizes them. */
        fun of(host: String, port: String, fingerprint: String, code: String, name: String? = null): Result<PairingLink> {
            val h = host.trim().removePrefix("[").removeSuffix("]")
            if (h.isEmpty()) return failure("The host is missing.")
            if (h.any { it.isWhitespace() || it == '/' || it == '?' || it == '#' }) return failure("The host is not valid.")
            val p = port.trim().toIntOrNull()
            if (p == null || p !in 1..65535) return failure("The port must be a number from 1 to 65535.")
            val fp = Fingerprint.normalize(fingerprint)
                ?: return failure("The fingerprint must be the SHA-256 of the certificate: 64 hexadecimal characters.")
            val c = code.trim()
            if (c.isEmpty()) return failure("The pairing code is missing.")
            return Result.success(PairingLink(h, p, fp, c, name?.trim()?.takeIf { it.isNotEmpty() }))
        }

        private fun parseQuery(raw: String): Map<String, String> = raw.split('&')
            .filter { it.isNotEmpty() }
            .associate { part ->
                val key = part.substringBefore('=')
                val value = if ('=' in part) part.substringAfter('=') else ""
                decode(key) to decode(value)
            }

        private fun decode(s: String): String = URLDecoder.decode(s, Charsets.UTF_8.name())

        private fun failure(message: String): Result<PairingLink> =
            Result.failure(IllegalArgumentException(message))
    }
}
