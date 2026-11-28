package dev.aura.android.net

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OlderServerTest {
    @Test
    fun `a method an older daemon refuses or does not know means the server is older`() {
        // 0.6.3's remote allowlist refuses usage.*, template.* and session.git_* with -32003.
        assertTrue(RpcException(RemoteErrors.FORBIDDEN, "method not allowed remotely: usage.summary").fromOlderServer)
        assertTrue(RpcException(RemoteErrors.METHOD_NOT_FOUND, "unknown method").fromOlderServer)
        assertFalse(RpcException(-32602, "invalid params").fromOlderServer)
        assertFalse(IllegalStateException("offline").fromOlderServer)
    }
}
