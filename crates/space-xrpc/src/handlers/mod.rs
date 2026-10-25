//! XRPC handler implementations.
//!
//! One module per NSID family. Every handler takes the resolved state, the
//! parsed params and the request context, and returns the response object —
//! nothing writes, and nothing formats JSON: the field order of the returned
//! struct is the wire order, so a struct here *is* the response contract.

pub mod bridge_tokens;
pub mod common;
pub mod federation;
pub mod membership;
pub mod message;
pub mod room;
pub mod search_rooms;
pub mod space;
pub mod space_info;
pub mod voice;
