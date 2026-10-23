//! Durable retry: the outbox.
//!
//! Every send that a platform can reject goes through an outbox entry with an
//! attempt count and a next-attempt time, so a homeserver outage is a delay
//! rather than a lost message. The policy is here (exponential with a cap) and
//! the *persistence* is the caller's — [`crate::Storage`] gives it one home.

use serde::{Deserialize, Serialize};

use crate::op::Op;
use crate::Millis;

/// How long to wait before re-offering a failed op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryPolicy {
    /// Delay before the first retry.
    pub base_delay_ms: i64,
    /// Ceiling for the exponential backoff.
    pub max_delay_ms: i64,
    /// Attempts after which the entry is parked instead of retried. A parked
    /// op is kept, not dropped: an operator can see it in the admin API and
    /// decide whether to requeue.
    pub max_attempts: u32,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_delay_ms: 1_000,
            max_delay_ms: 5 * 60 * 1_000,
            max_attempts: 10,
        }
    }
}

impl RetryPolicy {
    /// The delay before attempt `attempt` (1-based), doubled each time up to
    /// the ceiling.
    pub fn delay_for(&self, attempt: u32) -> i64 {
        if attempt == 0 {
            return 0;
        }
        let shift = (attempt - 1).min(30);
        let delay = self.base_delay_ms.saturating_mul(1i64 << shift);
        delay.min(self.max_delay_ms)
    }
}

/// What the outbox says to do with an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Due {
    /// Try it now.
    Ready,
    /// Not yet; the entry names the time.
    Later,
    /// Out of attempts. Kept for inspection, not retried.
    Parked,
}

/// One pending op, with its retry state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub id: String,
    pub op: Op,
    pub attempts: u32,
    pub next_attempt_at: Millis,
    pub last_error: Option<String>,
}

/// An ordered set of pending ops keyed by id.
///
/// Ordering is by `next_attempt_at` then insertion order, so a burst of ops
/// that arrived together preserves its original sequence — important because a
/// message and the edit that follows it must land in that order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Outbox {
    entries: Vec<Pending>,
    policy: RetryPolicy,
}

impl Outbox {
    pub fn new(policy: RetryPolicy) -> Self {
        Self {
            entries: Vec::new(),
            policy,
        }
    }

    pub fn policy(&self) -> RetryPolicy {
        self.policy
    }

    /// Queue an op, due immediately.
    pub fn enqueue(&mut self, id: impl Into<String>, op: Op, now: Millis) {
        self.entries.push(Pending {
            id: id.into(),
            op,
            attempts: 0,
            next_attempt_at: now,
            last_error: None,
        });
    }

    /// Record a successful send.
    pub fn complete(&mut self, id: &str) {
        self.entries.retain(|entry| entry.id != id);
    }

    /// Record a failed send: bump the attempt count and schedule the retry.
    /// Returns [`Due::Parked`] once the attempt budget is spent.
    pub fn retry(&mut self, id: &str, error: impl Into<String>, now: Millis) -> Due {
        let policy = self.policy;
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return Due::Parked;
        };
        entry.attempts = entry.attempts.saturating_add(1);
        entry.last_error = Some(error.into());
        if entry.attempts >= policy.max_attempts {
            return Due::Parked;
        }
        entry.next_attempt_at = now.saturating_add(policy.delay_for(entry.attempts));
        Due::Later
    }

    /// Everything due at `now`, in order.
    pub fn due(&self, now: Millis) -> Vec<&Pending> {
        self.entries
            .iter()
            .filter(|entry| entry.attempts < self.policy.max_attempts)
            .filter(|entry| entry.next_attempt_at <= now)
            .collect()
    }

    /// The state of one entry at `now`.
    pub fn state(&self, id: &str, now: Millis) -> Option<Due> {
        let entry = self.entries.iter().find(|entry| entry.id == id)?;
        Some(if entry.attempts >= self.policy.max_attempts {
            Due::Parked
        } else if entry.next_attempt_at <= now {
            Due::Ready
        } else {
            Due::Later
        })
    }

    /// Parked entries, for the admin API to report.
    pub fn parked(&self) -> Vec<&Pending> {
        self.entries
            .iter()
            .filter(|entry| entry.attempts >= self.policy.max_attempts)
            .collect()
    }

    /// Requeue a parked entry, keeping its attempt count so an operator's
    /// requeue does not reset the budget silently.
    pub fn requeue(&mut self, id: &str, now: Millis) -> bool {
        let policy = self.policy;
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return false;
        };
        entry.next_attempt_at = now;
        // Give the entry one more attempt past the budget so a requeue is not
        // immediately re-parked by the same check that parked it.
        if entry.attempts >= policy.max_attempts {
            entry.attempts = policy.max_attempts.saturating_sub(1);
        }
        true
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{GhostDid, RoomyRoomId};

    fn op() -> Op {
        Op::Send {
            roomy_room_id: RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            author: GhostDid::parse("did:matrix:%40a%3Aexample.org").unwrap(),
            body: "hi".into(),
            attachments: vec![],
            reply_to: None,
            timestamp: 0,
            origin: None,
        }
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let policy = RetryPolicy {
            base_delay_ms: 1_000,
            max_delay_ms: 8_000,
            max_attempts: 10,
        };
        assert_eq!(policy.delay_for(1), 1_000);
        assert_eq!(policy.delay_for(2), 2_000);
        assert_eq!(policy.delay_for(3), 4_000);
        assert_eq!(policy.delay_for(4), 8_000);
        assert_eq!(policy.delay_for(9), 8_000);
    }

    #[test]
    fn a_failure_schedules_the_retry_and_keeps_the_op() {
        let mut outbox = Outbox::new(RetryPolicy::default());
        outbox.enqueue("one", op(), 0);
        assert_eq!(outbox.state("one", 0), Some(Due::Ready));

        assert_eq!(outbox.retry("one", "500", 0), Due::Later);
        assert_eq!(outbox.state("one", 0), Some(Due::Later));
        assert_eq!(outbox.state("one", 1_000), Some(Due::Ready));
    }

    #[test]
    fn an_entry_is_parked_after_the_attempt_budget() {
        let mut outbox = Outbox::new(RetryPolicy {
            base_delay_ms: 1,
            max_delay_ms: 1,
            max_attempts: 3,
        });
        outbox.enqueue("one", op(), 0);
        assert_eq!(outbox.retry("one", "boom", 0), Due::Later);
        assert_eq!(outbox.retry("one", "boom", 0), Due::Later);
        assert_eq!(outbox.retry("one", "boom", 0), Due::Parked);
        assert_eq!(outbox.parked().len(), 1);
        assert!(outbox.due(1_000_000).is_empty());
    }

    #[test]
    fn a_requeued_entry_gets_one_more_attempt() {
        let mut outbox = Outbox::new(RetryPolicy {
            base_delay_ms: 1,
            max_delay_ms: 1,
            max_attempts: 1,
        });
        outbox.enqueue("one", op(), 0);
        assert_eq!(outbox.retry("one", "boom", 0), Due::Parked);
        assert!(outbox.requeue("one", 100));
        assert_eq!(outbox.state("one", 100), Some(Due::Ready));
    }

    #[test]
    fn completion_removes_the_entry() {
        let mut outbox = Outbox::new(RetryPolicy::default());
        outbox.enqueue("one", op(), 0);
        outbox.complete("one");
        assert!(outbox.is_empty());
    }

    #[test]
    fn due_preserves_insertion_order_for_ops_queued_together() {
        let mut outbox = Outbox::new(RetryPolicy::default());
        outbox.enqueue("a", op(), 0);
        outbox.enqueue("b", op(), 0);
        outbox.enqueue("c", op(), 0);
        let ids: Vec<_> = outbox.due(0).iter().map(|entry| entry.id.clone()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }
}
