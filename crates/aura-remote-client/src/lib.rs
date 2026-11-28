//! The desktop app as a client of other Aura installations (a home server,
//! another Mac), the way the Android app is one: pairing with a one-time
//! code, the remote's self-signed certificate pinned by fingerprint, a device
//! token per remote in the OS keychain, and a loopback bridge so the webview
//! talks to a remote exactly as it talks to its own daemon.
//!
//! Contract: docs/design/remote.md ("Desktop client").

pub mod hub;
pub mod pin;
pub mod store;

pub use hub::{BridgeInfo, HubConfig, LinkState, PairRequest, RemoteHub, RemoteView};
pub use store::{KeyringSecrets, MemorySecrets, RemoteEntry, Secrets};
