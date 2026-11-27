package dev.aura.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingLinkTest {
    private val fp = "a".repeat(64)

    @Test
    fun `a full link is read`() {
        val link = PairingLink.parse("aura://pair?host=192.168.1.20&port=7443&fp=$fp&code=ABCD-1234&name=Studio%20Mac").getOrThrow()
        assertEquals(PairingLink("192.168.1.20", 7443, fp, "ABCD-1234", "Studio Mac"), link)
    }

    @Test
    fun `the name is optional and whitespace around the link is ignored`() {
        val link = PairingLink.parse("  aura://pair?host=mac.local&port=1&fp=$fp&code=x\n").getOrThrow()
        assertNull(link.name)
        assertEquals("mac.local", link.host)
    }

    @Test
    fun `the parameters may come in any order and the fingerprint in any common form`() {
        val colons = fp.uppercase().chunked(2).joinToString(":")
        val link = PairingLink.parse("aura://pair?code=c&fp=$colons&port=80&host=h").getOrThrow()
        assertEquals(fp, link.fingerprint)
    }

    @Test
    fun `an IPv6 host may be bracketed`() {
        val link = PairingLink.parse("aura://pair?host=%5Bfe80%3A%3A1%5D&port=7443&fp=$fp&code=c").getOrThrow()
        assertEquals("fe80::1", link.host)
    }

    @Test
    fun `a plus in the code stays a plus once escaped`() {
        assertEquals("a+b", PairingLink.parse("aura://pair?host=h&port=1&fp=$fp&code=a%2Bb").getOrThrow().code)
    }

    @Test
    fun `other links are refused`() {
        for (text in listOf(
            "https://pair?host=h&port=1&fp=$fp&code=c",
            "aura://open?host=h&port=1&fp=$fp&code=c",
            "not a link at all",
            "",
        )) {
            assertTrue(text, PairingLink.parse(text).isFailure)
        }
    }

    @Test
    fun `missing or invalid fields are refused with a reason`() {
        val cases = mapOf(
            "aura://pair?port=1&fp=$fp&code=c" to "host",
            "aura://pair?host=h&fp=$fp&code=c" to "port",
            "aura://pair?host=h&port=0&fp=$fp&code=c" to "port",
            "aura://pair?host=h&port=65536&fp=$fp&code=c" to "port",
            "aura://pair?host=h&port=x&fp=$fp&code=c" to "port",
            "aura://pair?host=h&port=1&code=c" to "fingerprint",
            "aura://pair?host=h&port=1&fp=${"a".repeat(63)}&code=c" to "fingerprint",
            "aura://pair?host=h&port=1&fp=${"g".repeat(64)}&code=c" to "fingerprint",
            "aura://pair?host=h&port=1&fp=$fp" to "code",
            "aura://pair?host=h%2Fevil&port=1&fp=$fp&code=c" to "host",
        )
        for ((text, field) in cases) {
            val error = PairingLink.parse(text).exceptionOrNull()
            assertTrue("$text should fail on $field, got $error", error?.message?.contains(field, ignoreCase = true) == true)
        }
    }

    @Test
    fun `manual entry is checked like a link`() {
        val link = PairingLink.of(" host ", " 7443 ", fp.chunked(4).joinToString(" "), " 123456 ").getOrThrow()
        assertEquals(PairingLink("host", 7443, fp, "123456", null), link)
    }
}
