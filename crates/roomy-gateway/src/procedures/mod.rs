//! Procedures the gateway owns.
//!
//! Two kinds of write arrive at the edge rather than at a space worker:
//!
//!  * **The event log.** `sendEvents` is the only way an event enters a space.
//!    It validates and authorizes the batch, then appends the entry with its
//!    record changes; workers read the changes, never the entry.
//!  * **Caller-scoped state.** A read position is not an event and not a
//!    materialised row: it is the caller's own watermark, held in read state.
//!    Recording one needs the caller's identity and nothing else, so it is
//!    answered here rather than by a worker that would have to be told which of
//!    its spaces the room belongs to in order to write a row it does not own.

pub mod send_events;
pub mod update_seen;
