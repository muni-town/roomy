//! The write ingress: what a client sends, decided and appended.
//!
//! An event reaches a space by one route. `space.roomy.space.sendEvents`
//! validates the batch, authorizes every event against the sender's own
//! permissions, and appends the entry to the log — one transaction that writes
//! the entry, its record changes and the stream's latest index together. A
//! worker then applies the record changes; it never reads the entry.
//!
//! Three properties the ingress keeps:
//!
//!  * **Authorization is per event.** Membership is not a grant to send
//!    everything: a member may create a message in a channel they can write,
//!    and may not create a room or grant themselves a role. The decision is a
//!    function of the event type and the sender's access to the room it names.
//!  * **The append is one atomic step.** An entry whose record changes failed
//!    to encode never lands, and a landed entry always has its changes, so a
//!    worker replaying from any cursor sees a whole log.
//!  * **The adapter exists once.** Record changes are produced here, at the
//!    only place events enter, so a second implementation of the projection's
//!    input cannot drift from this one.

pub mod append;
pub mod event;
pub mod ids;
pub mod record_change;
pub mod record_kinds;
pub mod send_events;
pub mod write_auth;

pub use append::{AppendError, EventLog};
pub use event::WireEvent;
pub use record_change::{encode_bytes, EntryFacts, RecordChangeRow};
pub use send_events::{send_events, IngestState, SendEventsBody, SendEventsOutcome};
pub use write_auth::{check_write_auth, WriteAuth, WriteDenial};
