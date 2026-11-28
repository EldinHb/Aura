//! TLS to another Aura installation's remote listener, trusting exactly one
//! certificate: the one whose SHA-256 fingerprint was in the pairing link.
//! The listener's certificate is self-signed and its host name means nothing
//! (docs/design/remote.md §1), so there is no CA and no name check: the
//! fingerprint is the whole trust decision.

use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::Digest;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

/// A WebSocket to a remote listener, over TLS.
pub type RemoteWs = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

/// Lowercase hex SHA-256 of a DER certificate, no separators.
pub fn fingerprint(der: &[u8]) -> String {
    sha2::Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A fingerprint as typed or pasted: separators (`:`, spaces, dashes) dropped,
/// lowercased. None unless 64 hex characters are left.
pub fn normalize_fingerprint(s: &str) -> Option<String> {
    let fp: String = s
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-' | '\t' | '\n'))
        .collect::<String>()
        .to_ascii_lowercase();
    (fp.len() == 64 && fp.chars().all(|c| c.is_ascii_hexdigit())).then_some(fp)
}

/// Accepts exactly the certificate whose fingerprint is `pinned`, whatever its
/// name, issuer or dates; remembers the fingerprint of one it refused, so the
/// caller can tell a changed certificate from a network failure.
#[derive(Debug)]
pub struct PinnedVerifier {
    pinned: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
    refused: Mutex<Option<String>>,
}

impl PinnedVerifier {
    pub fn new(pinned: &str) -> Arc<Self> {
        Arc::new(Self {
            pinned: pinned.to_ascii_lowercase(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
            refused: Mutex::new(None),
        })
    }

    /// The fingerprint of a certificate this verifier refused, if any.
    pub fn refused(&self) -> Option<String> {
        self.refused.lock().clone()
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = fingerprint(end_entity.as_ref());
        // Comparing public values: no need for constant time.
        if got == self.pinned {
            Ok(ServerCertVerified::assertion())
        } else {
            *self.refused.lock() = Some(got.clone());
            Err(rustls::Error::General(format!(
                "certificate {got} is not the pinned {}",
                self.pinned
            )))
        }
    }

    // The handshake signatures are still checked, against the pinned
    // certificate's key: whoever answers must hold its private key.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Why a connection could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    /// The server showed another certificate than the pinned one. Never
    /// accepted: only pairing again trusts a new one.
    CertMismatch { expected: String, actual: String },
    /// Unreachable, refused, timed out, or the TLS or WebSocket handshake
    /// failed for another reason. Worth retrying.
    Network(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::CertMismatch { expected, actual } => write!(
                f,
                "the computer showed certificate {actual}, not the paired {expected}"
            ),
            ConnectError::Network(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ConnectError {}

/// How long opening a connection may take: TCP, TLS and the WebSocket upgrade.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest message the listener sends (docs/design/remote.md §4).
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

/// `host` as it goes in a URL: an IPv6 address in brackets.
fn url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Open `wss://host:port/`, accepting only the certificate `fingerprint`.
pub async fn connect(host: &str, port: u16, fingerprint: &str) -> Result<RemoteWs, ConnectError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(host, port, fingerprint)).await {
        Ok(r) => r,
        Err(_) => Err(ConnectError::Network(format!(
            "{}:{port} did not answer in time",
            url_host(host)
        ))),
    }
}

async fn connect_inner(host: &str, port: u16, fingerprint: &str) -> Result<RemoteWs, ConnectError> {
    let verifier = PinnedVerifier::new(fingerprint);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| ConnectError::Network(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let tcp = TcpStream::connect((bare, port))
        .await
        .map_err(|e| ConnectError::Network(format!("{}:{port}: {e}", url_host(bare))))?;
    let _ = tcp.set_nodelay(true);
    // The name is not checked (the fingerprint is); a fixed DNS name keeps an
    // IP address out of SNI.
    let name = ServerName::try_from("aura.local").expect("a valid DNS name");
    let tls = match tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
    {
        Ok(tls) => tls,
        Err(e) => {
            if let Some(actual) = verifier.refused() {
                return Err(ConnectError::CertMismatch {
                    expected: fingerprint.to_string(),
                    actual,
                });
            }
            return Err(ConnectError::Network(format!("TLS: {e}")));
        }
    };
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE),
        max_frame_size: Some(MAX_MESSAGE),
        ..Default::default()
    };
    let (ws, _) = tokio_tungstenite::client_async_with_config(
        format!("wss://{}:{port}/", url_host(bare)),
        tls,
        Some(ws_config),
    )
    .await
    .map_err(|e| ConnectError::Network(format!("WebSocket: {e}")))?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_normalized() {
        let fp = "ab".repeat(32);
        assert_eq!(normalize_fingerprint(&fp), Some(fp.clone()));
        let spaced = fp
            .to_uppercase()
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(normalize_fingerprint(&spaced), Some(fp));
        assert_eq!(normalize_fingerprint("abc"), None);
        assert_eq!(normalize_fingerprint(&"zz".repeat(32)), None);
    }

    #[test]
    fn ipv6_hosts_are_bracketed_in_urls() {
        assert_eq!(url_host("2001:db8::5"), "[2001:db8::5]");
        assert_eq!(url_host("[2001:db8::5]"), "[2001:db8::5]");
        assert_eq!(url_host("192.168.1.2"), "192.168.1.2");
    }
}
