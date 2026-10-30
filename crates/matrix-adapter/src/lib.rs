#![warn(missing_docs)]
//! Matrix side of the bridge: appservice transport, ghosts, media, and
//! end-to-bridge encryption.
//!
//! The adapter owns everything Matrix-shaped — ruma types, the `/transactions`
//! handler, `mxc://` uploads, membership events. It converts to and from the
//! platform-neutral vocabulary in `bridge-core` and performs no policy: whether
//! an event should be relayed is a `bridge-core` decision.
//!
//! Every call to a homeserver goes through [`transport`], which owns the base
//! url, the token, the request, the decoding and the retry verdict.

pub mod appservice;
pub mod capability;
pub mod ghosts;
pub mod media;
pub mod outbound;
pub mod transaction;
pub mod transport;

#[cfg(feature = "e2ee")]
pub mod e2ee;

#[cfg(feature = "e2ee")]
pub use e2ee::{CryptoError, CryptoMachine, CryptoTransport, EncryptedContent};

pub use appservice::{
    Appservice, AppserviceRegistration, AsToken, HsToken, Namespaces, Registered, Running,
    TokenError, Tokens, Unregistered,
};
pub use capability::{
    transaction_extension_keys, transaction_to_device, CapabilityProbe, HomeserverCapabilities,
    MscStatus, ObservedTransaction, TransactionObserver,
};
pub use ghosts::{GhostRegistry, GhostUser};
pub use media::{MediaStore, MxcUri};
pub use outbound::{
    edit_content, media_content, reaction_content, redaction_content, reply_content, text_content,
    HttpSender, MatrixSendError, MatrixSender, OutgoingContent,
};
pub use transaction::{Transaction, TransactionHandler};
pub use transport::{
    Body, CreateRoomRequest, Exchange, ExchangeError, FakeHomeserver, FakeResponse,
    HomeserverClient, HttpExchange, MediaDownload, Method, Request, Response, RoomSummary,
    SpaceChildContent, Transport, TransportError,
};
