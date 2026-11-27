package dev.aura.android.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import dev.aura.android.R
import dev.aura.android.net.ConnectionState

/** The connection state in a few words. */
@Composable
fun ConnectionState.describe(): String = when (this) {
    ConnectionState.Offline -> stringResource(R.string.conn_offline)
    ConnectionState.Connecting -> stringResource(R.string.conn_connecting)
    is ConnectionState.Online -> stringResource(R.string.conn_online)
    is ConnectionState.Retrying -> stringResource(R.string.conn_retrying, reason)
    is ConnectionState.Revoked -> stringResource(R.string.conn_revoked)
    is ConnectionState.CertificateMismatch -> stringResource(R.string.conn_cert_mismatch)
}

@Composable
fun ConnectionState.color(): Color = when (this) {
    is ConnectionState.Online -> MaterialTheme.colorScheme.primary
    is ConnectionState.Revoked, is ConnectionState.CertificateMismatch -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** Whether only pairing again can bring this connection back. */
val ConnectionState.needsPairing: Boolean
    get() = this is ConnectionState.Revoked || this is ConnectionState.CertificateMismatch
