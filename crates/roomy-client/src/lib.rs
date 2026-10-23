//! XRPC client for the Roomy appserver.
//!
//! Three things this crate does that a plain HTTP client would not:
//!
//! * **Service-auth tokens.** Every call carries a JWT minted by the bridge's
//!   PDS through `com.atproto.server.getServiceAuth`, with `aud` set to the
//!   appserver DID and `lxm` to the method. Tokens are cached per `aud:lxm` and
//!   refreshed before expiry, because the appserver verifies them per call.
//! * **Event encoding.** `sendEvents` takes JSON, while the sync socket speaks
//!   CBOR frames; both come from [`roomy_events`] so there is one definition of
//!   each event.
//! * **The sync socket.** A long-lived WebSocket that authenticates with a
//!   short-lived ticket, subscribes to a space stream, and yields the events
//!   the bridge relays to Matrix.

pub mod auth;
pub mod error;
pub mod xrpc;

pub use auth::{ServiceAuth, SessionCredentials};
pub use error::ClientError;
pub use xrpc::{AppserverClient, MembersResponse, SyncEvent, SyncSubscription};

/// The appserver's per-batch cap on `sendEvents`.
pub const MAX_EVENTS_PER_BATCH: usize = 50;
