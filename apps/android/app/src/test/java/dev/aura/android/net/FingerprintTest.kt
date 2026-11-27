package dev.aura.android.net

import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException

class FingerprintTest {
    private val cert = HeldCertificate.Builder().commonName("aurad").build().certificate
    private val other = HeldCertificate.Builder().commonName("aurad").build().certificate

    @Test
    fun `the fingerprint is the SHA-256 of the DER encoding in lowercase hex`() {
        val expected = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
        assertEquals(expected, Fingerprint.of(cert))
        assertEquals(64, expected.length)
    }

    @Test
    fun `fingerprints are normalized from common notations`() {
        val fp = Fingerprint.of(cert)
        assertEquals(fp, Fingerprint.normalize(fp.uppercase()))
        assertEquals(fp, Fingerprint.normalize(fp.chunked(2).joinToString(":")))
        assertEquals(fp, Fingerprint.normalize(fp.chunked(4).joinToString(" ")))
        assertNull(Fingerprint.normalize(fp.drop(2)))
        assertNull(Fingerprint.normalize("z" + fp.drop(1)))
    }

    @Test
    fun `the pinned certificate is trusted`() {
        PinnedTrustManager(Fingerprint.of(cert)).checkServerTrusted(arrayOf(cert), "ECDHE_ECDSA")
    }

    @Test
    fun `any other certificate is refused, naming both fingerprints`() {
        val e = assertThrows(FingerprintMismatchException::class.java) {
            PinnedTrustManager(Fingerprint.of(cert)).checkServerTrusted(arrayOf(other), "ECDHE_ECDSA")
        }
        assertEquals(Fingerprint.of(cert), e.expected)
        assertEquals(Fingerprint.of(other), e.actual)
    }

    @Test
    fun `only the leaf certificate counts, not one further up the chain`() {
        assertThrows(FingerprintMismatchException::class.java) {
            PinnedTrustManager(Fingerprint.of(cert)).checkServerTrusted(arrayOf(other, cert), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `an empty chain and client certificates are refused`() {
        val trust = PinnedTrustManager(Fingerprint.of(cert))
        assertThrows(CertificateException::class.java) { trust.checkServerTrusted(emptyArray(), "RSA") }
        assertThrows(CertificateException::class.java) { trust.checkClientTrusted(arrayOf(cert), "RSA") }
        assertEquals(0, trust.acceptedIssuers.size)
    }

    @Test
    fun `a mismatch is found among the causes of a handshake error`() {
        val mismatch = FingerprintMismatchException("a", "b")
        val wrapped = SSLHandshakeException("handshake failed").apply { initCause(RuntimeException(mismatch)) }
        assertSame(mismatch, wrapped.fingerprintMismatch())
        assertNull(SSLHandshakeException("other").fingerprintMismatch())
    }
}
