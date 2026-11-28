//! WebSocket frames (device tokens, pair codes) never reach a log, even at
//! trace level and even when RUST_LOG names the WebSocket library itself.

use std::sync::{Arc, Mutex};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Layer;

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<String>>>);

impl<S: tracing::Subscriber> Layer<S> for Seen {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        self.0
            .lock()
            .unwrap()
            .push(event.metadata().target().to_string());
    }
}

#[test]
fn websocket_frames_are_never_logged() {
    let seen = Seen::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            "trace,tungstenite::protocol=trace,tokio_tungstenite=trace",
        ))
        .with(aura_rpc::quiet_wire_logs())
        .with(seen.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::trace!(target: "tungstenite::protocol", "Received message {{\"token\":\"secret\"}}");
        tracing::trace!(target: "tungstenite", "frame");
        tracing::trace!(target: "tokio_tungstenite::compat", "frame");
        tracing::trace!(target: "tungstenite_lookalike", "kept");
        tracing::trace!(target: "aura_rpc::remote", "kept");
    });
    assert_eq!(
        *seen.0.lock().unwrap(),
        vec![
            "tungstenite_lookalike".to_string(),
            "aura_rpc::remote".to_string()
        ]
    );
    assert!(aura_rpc::is_wire_log_target(
        "tungstenite::handshake::client"
    ));
    assert!(!aura_rpc::is_wire_log_target("rustls"));
}
