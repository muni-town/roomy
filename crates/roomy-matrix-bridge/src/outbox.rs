//! The durable outbox for events on their way to the appserver.
//!
//! A batch is written to `failed_sends` before its first attempt and deleted
//! only when the appserver accepts it, so a restart resumes the same schedule.
//! The retry rule — exponential backoff, the attempt budget, parking — is
//! [`bridge_core::RetryState`] over [`bridge_core::RetryPolicy`]; this module
//! owns durability and queue order, not a second copy of that rule.
//!
//! Failures stay in the queue: a rejected batch is retried, a batch whose
//! payload cannot be decoded is dropped, and a batch that spends its budget is
//! parked — kept for inspection and requeue, never offered again.

use std::sync::Arc;
use std::time::Duration;

use bridge_core::{Clock, Due, Millis, RetryPolicy, RetryState};
use parking_lot::Mutex;
use roomy_events::{Did, Event};

use crate::db::{BridgeDb, DbError, FailedSendRow, FailedSendWrite};

/// The most batches one drain hands to the appserver before the caller
/// re-evaluates the schedule.
const DRAIN_LIMIT: usize = 10;

/// A batch the appserver has not yet accepted, with its retry state.
#[derive(Debug, Clone, PartialEq)]
pub struct Queued {
    id: String,
    space_did: Did,
    events: Vec<Event>,
    payload: String,
    state: RetryState,
}

impl Queued {
    /// The id the batch is stored under.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The space the batch's events belong to.
    pub fn space_did(&self) -> &Did {
        &self.space_did
    }

    /// The events in the batch.
    pub fn events(&self) -> &[Event] {
        &self.events
    }
}

/// What one attempt did with one batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The appserver accepted it; the row is gone.
    Sent { id: String },
    /// Rejected and scheduled for a later attempt.
    Retried { id: String, next_attempt_at: Millis },
    /// Rejected with the attempt budget spent; kept, not retried.
    Parked { id: String, error: String },
    /// The stored payload could not be decoded; deleted rather than failed
    /// identically forever.
    Dropped { id: String, reason: String },
}

/// The retry state after a rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejected {
    pub due: Due,
    pub next_attempt_at: Millis,
}

/// What the outbox needs from its destination.
pub trait EventSink {
    /// Hand one batch over. An `Err` is a rejection worth retrying.
    async fn send(&self, space_did: &Did, events: &[Event]) -> Result<(), String>;
}

impl EventSink for roomy_client::AppserverClient {
    async fn send(&self, space_did: &Did, events: &[Event]) -> Result<(), String> {
        self.send_events(space_did, events.to_vec())
            .await
            .map_err(|error| error.to_string())
    }
}

/// A queue failure.
#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    #[error(transparent)]
    Store(#[from] DbError),
    #[error("could not encode the batch: {0}")]
    Encode(#[from] serde_json::Error),
}

/// The queue of batches bound for the appserver, persisted in `failed_sends`.
pub struct Outbox {
    db: Arc<Mutex<BridgeDb>>,
    policy: RetryPolicy,
    clock: Arc<dyn Clock>,
}

impl Outbox {
    /// A queue persisting to `db` and retrying by `policy`.
    pub fn new(db: Arc<Mutex<BridgeDb>>, policy: RetryPolicy, clock: Arc<dyn Clock>) -> Self {
        Self { db, policy, clock }
    }

    /// Persist a batch, due now. An empty batch has nothing to send and is
    /// not queued.
    ///
    /// A batch whose id is already queued keeps its attempts and its retry
    /// time: re-delivery is not a fresh budget.
    pub fn enqueue(&self, space_did: &Did, events: Vec<Event>) -> Result<(), OutboxError> {
        let Some(first) = events.first().map(|event| event.id.as_str().to_string()) else {
            return Ok(());
        };
        let now = self.clock.now_ms();
        let state = match self.db.lock().failed_send(&first)? {
            Some(row) => RetryState {
                attempts: row.attempts,
                next_attempt_at: row.next_attempt_at,
            },
            None => RetryState::new(now),
        };
        let payload = encode(&events)?;
        self.db.lock().put_failed_send(&FailedSendWrite {
            id: &first,
            space_did: space_did.as_str(),
            payload: &payload,
            attempts: state.attempts,
            next_attempt_at: state.next_attempt_at,
            last_error: None,
            created_at: now,
        })?;
        Ok(())
    }

    /// When the queue next has work, or `None` when it holds nothing
    /// retryable — empty, or entirely parked.
    pub fn next_due_at(&self) -> Result<Option<Millis>, OutboxError> {
        Ok(self
            .db
            .lock()
            .next_failed_send_at(self.policy.max_attempts)?)
    }

    /// How long a consumer may wait before the queue has work. `None` means
    /// nothing is pending except parked batches, so only a new enqueue can
    /// produce work.
    pub fn wait(&self) -> Result<Option<Duration>, OutboxError> {
        let Some(at) = self.next_due_at()? else {
            return Ok(None);
        };
        let now = self.clock.now_ms();
        Ok(Some(Duration::from_millis(
            at.saturating_sub(now).max(0) as u64
        )))
    }

    /// Send every batch due now, recording what became of each.
    pub async fn drain<S: EventSink>(&self, sink: &S) -> Result<Vec<Outcome>, OutboxError> {
        let now = self.clock.now_ms();
        let rows = self
            .db
            .lock()
            .due_failed_sends(now, self.policy.max_attempts, DRAIN_LIMIT)?;

        let mut outcomes = Vec::with_capacity(rows.len());
        for row in rows {
            let batch = match decode(row) {
                Ok(batch) => batch,
                Err((id, reason)) => {
                    tracing::error!(id = %id, %reason, "dropping an unreadable retry payload");
                    self.complete(&id)?;
                    outcomes.push(Outcome::Dropped { id, reason });
                    continue;
                }
            };

            // Re-sending is safe: the appserver treats a repeated ULID as a
            // no-op, so an event that already landed is not written twice.
            match sink.send(batch.space_did(), batch.events()).await {
                Ok(()) => {
                    self.complete(batch.id())?;
                    outcomes.push(Outcome::Sent {
                        id: batch.id().to_string(),
                    });
                }
                Err(error) => {
                    tracing::warn!(id = %batch.id(), %error, "sendEvents failed");
                    let rejected = self.fail(&batch, &error)?;
                    let id = batch.id().to_string();
                    outcomes.push(match rejected.due {
                        Due::Parked => {
                            tracing::error!(id = %id, %error, "retry budget spent; parking the batch");
                            Outcome::Parked { id, error }
                        }
                        _ => Outcome::Retried {
                            id,
                            next_attempt_at: rejected.next_attempt_at,
                        },
                    });
                }
            }
        }
        Ok(outcomes)
    }

    /// Record that the appserver accepted a batch.
    pub fn complete(&self, id: &str) -> Result<(), OutboxError> {
        self.db.lock().clear_failed_send(id)?;
        Ok(())
    }

    /// Record a rejected batch: schedule its retry, or park it once the
    /// attempt budget is spent.
    pub fn fail(&self, batch: &Queued, error: &str) -> Result<Rejected, OutboxError> {
        let now = self.clock.now_ms();
        let mut state = batch.state;
        let due = state.record_failure(&self.policy, now);
        self.db.lock().put_failed_send(&FailedSendWrite {
            id: &batch.id,
            space_did: batch.space_did.as_str(),
            payload: &batch.payload,
            attempts: state.attempts,
            next_attempt_at: state.next_attempt_at,
            last_error: Some(error),
            created_at: now,
        })?;
        Ok(Rejected {
            due,
            next_attempt_at: state.next_attempt_at,
        })
    }
}

/// The wire shape of the stored payload: the `sendEvents` event array.
fn encode(events: &[Event]) -> Result<String, serde_json::Error> {
    serde_json::to_string(&events.iter().map(Event::to_json).collect::<Vec<_>>())
}

fn decode(row: FailedSendRow) -> Result<Queued, (String, String)> {
    let FailedSendRow {
        id,
        space_did,
        op: payload,
        attempts,
        next_attempt_at,
        ..
    } = row;
    let events = serde_json::from_str::<Vec<serde_json::Value>>(&payload)
        .map_err(|error| (id.clone(), format!("unreadable payload: {error}")))
        .and_then(|values| {
            values
                .into_iter()
                .map(Event::from_json)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| (id.clone(), format!("unreadable event: {error}")))
        })?;
    let space_did =
        Did::parse(space_did).map_err(|_| (id.clone(), "space DID is not a DID".to_string()))?;
    Ok(Queued {
        id,
        space_did,
        events,
        payload,
        state: RetryState {
            attempts,
            next_attempt_at,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use bridge_core::VirtualClock;
    use roomy_events::{EventKind, Ulid};

    use super::*;
    use crate::db::BridgeDb;

    const SPACE: &str = "did:plc:space";

    fn policy() -> RetryPolicy {
        RetryPolicy {
            base_delay_ms: 1_000,
            max_delay_ms: 4_000,
            max_attempts: 3,
        }
    }

    fn event(id: &str) -> Event {
        Event::in_space(
            Ulid::parse(id).unwrap(),
            EventKind::CreateMessage(roomy_events::CreateMessage {
                body: roomy_events::Content::markdown("hello"),
                extensions: Default::default(),
            }),
        )
    }

    fn batch() -> Vec<Event> {
        vec![event("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB")]
    }

    /// A sink that answers from a script and records what it was asked to send.
    struct ScriptedSink {
        answers: Mutex<VecDeque<Result<(), String>>>,
        fallback: Result<(), String>,
        sent: Mutex<Vec<Vec<Event>>>,
    }

    impl Default for ScriptedSink {
        fn default() -> Self {
            Self {
                answers: Mutex::new(VecDeque::new()),
                fallback: Ok(()),
                sent: Mutex::new(Vec::new()),
            }
        }
    }

    impl ScriptedSink {
        /// Fails the first `times` sends, then accepts.
        fn failing(times: usize) -> Self {
            let sink = Self::default();
            for _ in 0..times {
                sink.answers.lock().push_back(Err("503".into()));
            }
            sink
        }

        /// Rejects every send.
        fn always_failing() -> Self {
            Self {
                fallback: Err("503".into()),
                ..Self::default()
            }
        }

        fn sent(&self) -> usize {
            self.sent.lock().len()
        }
    }

    impl EventSink for ScriptedSink {
        async fn send(&self, _space_did: &Did, events: &[Event]) -> Result<(), String> {
            self.sent.lock().push(events.to_vec());
            self.answers
                .lock()
                .pop_front()
                .unwrap_or_else(|| self.fallback.clone())
        }
    }

    fn outbox() -> (Arc<Mutex<BridgeDb>>, Arc<VirtualClock>, Outbox) {
        let db = Arc::new(Mutex::new(BridgeDb::open_in_memory().unwrap()));
        let clock = Arc::new(VirtualClock::new(0));
        let outbox = Outbox::new(db.clone(), policy(), clock.clone());
        (db, clock, outbox)
    }

    #[tokio::test]
    async fn a_failed_batch_is_retried_when_due() {
        let (db, clock, outbox) = outbox();
        let sink = ScriptedSink::failing(1);

        outbox
            .enqueue(&Did::parse(SPACE).unwrap(), batch())
            .unwrap();
        assert_eq!(outbox.wait().unwrap(), Some(Duration::ZERO));

        let outcomes = outbox.drain(&sink).await.unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [Outcome::Retried {
                next_attempt_at: 1_000,
                ..
            }]
        ));
        assert_eq!(db.lock().failed_send(&id()).unwrap().unwrap().attempts, 1);
        assert_eq!(outbox.wait().unwrap(), Some(Duration::from_millis(1_000)));

        // Not due yet: a second drain does not touch the appserver.
        assert!(outbox.drain(&sink).await.unwrap().is_empty());
        assert_eq!(sink.sent(), 1);

        clock.advance(1_000);
        let outcomes = outbox.drain(&sink).await.unwrap();
        assert_eq!(
            outcomes,
            vec![Outcome::Sent {
                id: id().to_string()
            }]
        );
        assert_eq!(sink.sent(), 2);
        assert!(db.lock().failed_send(&id()).unwrap().is_none());
        assert_eq!(outbox.wait().unwrap(), None);
    }

    #[tokio::test]
    async fn a_spent_budget_parks_the_batch() {
        let (db, clock, outbox) = outbox();
        let sink = ScriptedSink::always_failing();

        outbox
            .enqueue(&Did::parse(SPACE).unwrap(), batch())
            .unwrap();

        let mut parked = false;
        for _ in 0..policy().max_attempts {
            let outcomes = outbox.drain(&sink).await.unwrap();
            parked = matches!(outcomes.as_slice(), [Outcome::Parked { .. }]);
            clock.advance(4_000);
        }

        assert!(parked, "the last attempt within the budget parks the batch");
        let row = db.lock().failed_send(&id()).unwrap().unwrap();
        assert_eq!(row.attempts, policy().max_attempts);
        assert!(row.last_error.is_some());
        // Parked: never due again, and nothing for a consumer to wait for.
        assert_eq!(outbox.wait().unwrap(), None);
        clock.advance(1_000_000);
        assert!(outbox.drain(&sink).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_payload_is_dropped_not_retried() {
        let (db, clock, outbox) = outbox();
        let sink = ScriptedSink::default();
        db.lock()
            .put_failed_send(&FailedSendWrite {
                id: "poisoned",
                space_did: SPACE,
                payload: "{not a batch",
                attempts: 0,
                next_attempt_at: 0,
                last_error: None,
                created_at: 0,
            })
            .unwrap();

        let outcomes = outbox.drain(&sink).await.unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [Outcome::Dropped { id, .. }] if id == "poisoned"
        ));
        assert_eq!(sink.sent(), 0);
        assert!(db.lock().failed_send("poisoned").unwrap().is_none());
        assert_eq!(outbox.wait().unwrap(), None);
        clock.advance(10_000);
        assert!(outbox.drain(&sink).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_queue_survives_a_restart() {
        let (db, clock, outbox) = outbox();
        outbox
            .enqueue(&Did::parse(SPACE).unwrap(), batch())
            .unwrap();
        drop(outbox);

        // A restart reopens the same store and takes over the surviving row.
        let reopened = Outbox::new(db, policy(), clock);
        let sink = ScriptedSink::default();
        assert_eq!(reopened.wait().unwrap(), Some(Duration::ZERO));
        let outcomes = reopened.drain(&sink).await.unwrap();
        assert_eq!(sink.sent(), 1);
        assert_eq!(
            outcomes,
            vec![Outcome::Sent {
                id: id().to_string()
            }]
        );
    }

    #[tokio::test]
    async fn an_empty_batch_is_not_queued() {
        let (db, _clock, outbox) = outbox();
        outbox
            .enqueue(&Did::parse(SPACE).unwrap(), Vec::new())
            .unwrap();
        assert_eq!(outbox.wait().unwrap(), None);
        assert_eq!(db.lock().next_failed_send_at(1).unwrap(), None);
    }

    #[tokio::test]
    async fn a_reenqueued_batch_keeps_its_attempt_budget() {
        let (db, clock, outbox) = outbox();
        let sink = ScriptedSink::failing(1);
        let space = Did::parse(SPACE).unwrap();

        outbox.enqueue(&space, batch()).unwrap();
        outbox.drain(&sink).await.unwrap();
        clock.advance(1_000);

        // The same batch reaching the queue again does not reset its budget.
        outbox.enqueue(&space, batch()).unwrap();
        assert_eq!(db.lock().failed_send(&id()).unwrap().unwrap().attempts, 1);
        outbox.drain(&sink).await.unwrap();
        assert_eq!(sink.sent(), 2);
        assert!(db.lock().failed_send(&id()).unwrap().is_none());
    }

    fn id() -> String {
        "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB".to_string()
    }
}
