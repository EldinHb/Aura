package dev.aura.android.net

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** The server showed a certificate other than the one this device paired with. */
class FingerprintMismatchException(
    val expected: String,
    val actual: String,
) : CertificateException("The server's certificate is $actual, not the paired $expected")

/**
 * Trusts exactly one certificate: the one whose SHA-256 is [fingerprint].
 * Aura servers use self-signed certificates, so no CA is consulted; the
 * fingerprint, which the user confirmed when pairing, is the trust.
 */
class PinnedTrustManager(fingerprint: String) : X509TrustManager {
    private val pinned: String = requireNotNull(Fingerprint.normalize(fingerprint)) { "not a SHA-256 fingerprint" }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("The server sent no certificate")
        val actual = Fingerprint.of(leaf)
        if (!MessageDigest.isEqual(actual.toByteArray(), pinned.toByteArray())) {
            throw FingerprintMismatchException(pinned, actual)
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not accepted")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * [base] set up to reach a server whose certificate is [fingerprint], and
 * nothing else. The host name is not checked, as a self-signed certificate
 * names no host the phone reaches it by, but only after the pinned trust
 * manager accepted the certificate, and only for that certificate.
 */
fun OkHttpClient.Builder.pinnedTo(fingerprint: String): OkHttpClient.Builder {
    val trust = PinnedTrustManager(fingerprint)
    val pinned = Fingerprint.normalize(fingerprint)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
    return sslSocketFactory(context.socketFactory, trust)
        .hostnameVerifier { _, session ->
            val leaf = runCatching { session.peerCertificates.firstOrNull() }.getOrNull()
            leaf != null && Fingerprint.of(leaf) == pinned
        }
}

/** The [FingerprintMismatchException] among this error's causes, if any. */
fun Throwable.fingerprintMismatch(): FingerprintMismatchException? {
    val seen = HashSet<Throwable>()
    val queue = ArrayDeque(listOf(this))
    while (queue.isNotEmpty()) {
        val e = queue.removeFirst()
        if (!seen.add(e)) continue
        if (e is FingerprintMismatchException) return e
        e.cause?.let(queue::addLast)
        queue.addAll(e.suppressed)
    }
    return null
}
