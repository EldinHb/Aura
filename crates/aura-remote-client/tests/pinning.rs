//! The pinning verifier against a real TLS WebSocket server: the pinned
//! certificate is accepted, any other is refused (and named), and a server
//! that changes its certificate is refused from then on.

use aura_remote_client::pin::{self, ConnectError, PinnedVerifier};
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use std::sync::Arc;
use tokio::net::TcpListener;

struct Cert {
    der: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    fp: String,
}

fn cert() -> Cert {
    let c = rcgen::generate_simple_self_signed(vec!["aura".into()]).unwrap();
    let der = c.cert.der().clone();
    Cert {
        fp: pin::fingerprint(der.as_ref()),
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(c.key_pair.serialize_der())),
        der,
    }
}

/// A TLS WebSocket server with `cert` on `listener`, answering every
/// connection until the task is aborted.
fn serve(listener: TcpListener, cert: &Cert) -> tokio::task::JoinHandle<()> {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert.der.clone()], cert.key.clone_key())
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(tcp).await {
                    let _ = tokio_tungstenite::accept_async(tls).await;
                }
            });
        }
    })
}

#[test]
fn the_verifier_accepts_only_the_pinned_certificate() {
    let (a, b) = (cert(), cert());
    let name = ServerName::try_from("anything.example").unwrap();
    let v = PinnedVerifier::new(&a.fp);
    assert!(v
        .verify_server_cert(&a.der, &[], &name, &[], UnixTime::now())
        .is_ok());
    assert_eq!(v.refused(), None);
    assert!(v
        .verify_server_cert(&b.der, &[], &name, &[], UnixTime::now())
        .is_err());
    assert_eq!(v.refused(), Some(b.fp.clone()));
    // Upper case in the pin is the same fingerprint.
    let v = PinnedVerifier::new(&a.fp.to_uppercase());
    assert!(v
        .verify_server_cert(&a.der, &[], &name, &[], UnixTime::now())
        .is_ok());
}

#[tokio::test]
async fn connects_with_the_pinned_certificate_and_refuses_another() {
    let a = cert();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = serve(listener, &a);

    pin::connect("127.0.0.1", port, &a.fp)
        .await
        .expect("the pinned certificate is accepted");

    let other = "0".repeat(64);
    match pin::connect("127.0.0.1", port, &other).await {
        Err(ConnectError::CertMismatch { expected, actual }) => {
            assert_eq!(expected, other);
            assert_eq!(actual, a.fp);
        }
        r => panic!("expected a certificate mismatch, got {:?}", r.map(|_| ())),
    }
    server.abort();
}

#[tokio::test]
async fn a_server_whose_certificate_changes_is_refused() {
    let (a, b) = (cert(), cert());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = serve(listener, &a);
    pin::connect("127.0.0.1", port, &a.fp).await.unwrap();
    server.abort();
    let _ = server.await;

    // Same address and port, another certificate: a different machine, or
    // someone in the middle. Refused, and the new fingerprint is named.
    let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let server = serve(listener, &b);
    match pin::connect("127.0.0.1", port, &a.fp).await {
        Err(ConnectError::CertMismatch { expected, actual }) => {
            assert_eq!(expected, a.fp);
            assert_eq!(actual, b.fp);
        }
        r => panic!("expected a certificate mismatch, got {:?}", r.map(|_| ())),
    }
    server.abort();
}

#[tokio::test]
async fn nobody_listening_is_a_network_error() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    match pin::connect("127.0.0.1", port, &"0".repeat(64)).await {
        Err(ConnectError::Network(_)) => {}
        r => panic!("expected a network error, got {:?}", r.map(|_| ())),
    }
}
