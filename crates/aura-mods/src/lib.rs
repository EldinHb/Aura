//! The mod host: runs the daemon halves of mods inside aurad and serves the
//! `mods.*` and `mod.<id>.*` RPC methods. See docs/mods/SPEC.md.

pub mod agents;
pub mod host;
pub mod http;
pub mod manifest;
pub mod ops;
pub mod runtime;
pub mod storage;

pub use host::{bundled_dir_near, Config, ModHost, ModSource};
pub use runtime::ModError;

#[cfg(test)]
mod host_tests;
#[cfg(test)]
mod runtime_tests;
