//! The connection plane, without a socket.
//!
//! A gateway holds thousands of WebSocket connections, each subscribed to the
//! spaces its user can read. The decisions that plane makes — which connection
//! hears an event, in what order, with what sequence number, and what a
//! reconnect resumes from — are pure functions of a signal stream and a set of
//! subscriptions. This crate is those decisions, and the axum adapter is a thin
//! skin over them.
//!
//! Everything is deterministic: the same inputs produce the same commands, so a
//! simulation can drive thousands of connections through subscribe, deny,
//! reconnect and backfill without a network.
//!
//! ## The contract
//!
//!  * **One connection, one order.** Each session numbers its frames from 1 up.
//!    A gap tells the client to resubscribe, so the core never renumbers.
//!  * **A signal is advisory.** Dropping one delays freshness; it never changes
//!    an answer, and the core does not retry.
//!  * **Access is checked when the subscription is made, and again on reconnect.**
//!    A denied subscription closes the session instead of silently sending
//!    nothing, which is a fact the client can act on.
//!  * **A reconnect is a new session.** Its cursor is whatever the client
//!    carries; the core never reuses another session's position.

use std::collections::{BTreeMap, BTreeSet};

/// A connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u64);

/// What a connection is subscribed to: one space's changes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Topic(pub String);

impl Topic {
    /// The topic of `space`'s changes.
    #[must_use]
    pub fn space(space: &str) -> Self {
        Self(space.to_string())
    }

    /// The topic's wire name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the core is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// A connection opened for `did`. `spaces` is what its ticket allowed.
    Open {
        did: String,
        spaces: BTreeSet<String>,
    },
    /// The client asked for a topic.
    Subscribe { session: SessionId, topic: String },
    /// A worker committed changes for `space`.
    Signal { space: String, cursor: (i64, i64) },
    /// The connection is gone.
    Closed { session: SessionId },
    /// A client asks to resume a stream from a cursor after a reconnect.
    Backfill {
        session: SessionId,
        topic: String,
        from: (i64, i64),
    },
}

/// What the core tells the adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Write `frame` to `session`.
    Send { session: SessionId, frame: Frame },
    /// A backfill request the adapter fulfils from the space's log.
    ReadBackfill {
        session: SessionId,
        topic: String,
        from: (i64, i64),
        to: (i64, i64),
    },
    /// Close `session` with a WebSocket close code and reason.
    Close {
        session: SessionId,
        code: u16,
        reason: String,
    },
}

/// One frame on a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// Monotonic within the session, from 1.
    pub seq: u64,
    /// The topic the frame is about.
    pub topic: String,
    /// The kind of frame: `subscribed`, `changed`, `backfill`.
    pub kind: &'static str,
    /// The cursor or cursor range the frame carries.
    pub data: FrameData,
}

/// A frame's payload, small enough to read in a test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameData {
    /// The subscription is live, from this cursor.
    Subscribed { cursor: (i64, i64) },
    /// The space changed at this cursor.
    Changed { cursor: (i64, i64) },
    /// Rows a client should read between two cursors.
    Backfill { from: (i64, i64), to: (i64, i64) },
}

#[derive(Debug, Clone)]
struct Session {
    did: String,
    spaces: BTreeSet<String>,
    /// Frames sent on this session; the next frame is `seq + 1`.
    seq: u64,
    subscriptions: BTreeSet<String>,
    /// The newest cursor the session has been told about, per topic.
    cursors: BTreeMap<String, (i64, i64)>,
}

/// The session core: subscriptions, sequence numbers, and frame derivation.
#[derive(Debug, Default)]
pub struct SessionCore {
    sessions: BTreeMap<SessionId, Session>,
    /// topic → the sessions subscribed to it, in session order.
    topics: BTreeMap<String, BTreeSet<SessionId>>,
    next_session: u64,
}

impl SessionCore {
    /// An empty core: no sessions, no subscriptions.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many connections are open.
    #[must_use]
    pub fn sessions(&self) -> usize {
        self.sessions.len()
    }

    /// The sessions subscribed to `topic`, in session order.
    pub fn subscribers(&self, topic: &str) -> impl Iterator<Item = SessionId> + '_ {
        self.topics
            .get(topic)
            .into_iter()
            .flat_map(|sessions| sessions.iter().copied())
    }

    /// The topics a session is subscribed to.
    pub fn subscriptions(&self, session: SessionId) -> impl Iterator<Item = &str> + '_ {
        self.sessions
            .get(&session)
            .into_iter()
            .flat_map(|state| state.subscriptions.iter().map(String::as_str))
    }

    /// Apply one input, returning the commands the adapter must carry out.
    pub fn apply(&mut self, input: Input) -> Vec<Command> {
        match input {
            Input::Open { did, spaces } => {
                let session = SessionId(self.next_session + 1);
                self.next_session += 1;
                let mut state = Session {
                    did,
                    spaces,
                    seq: 0,
                    subscriptions: BTreeSet::new(),
                    cursors: BTreeMap::new(),
                };
                let frame = next_frame(
                    &mut state,
                    "",
                    "ready",
                    FrameData::Subscribed { cursor: (0, 0) },
                );
                self.sessions.insert(session, state);
                vec![Command::Send { session, frame }]
            }
            Input::Subscribe { session, topic } => {
                let Some(state) = self.sessions.get_mut(&session) else {
                    return vec![Command::Close {
                        session,
                        code: 4404,
                        reason: "no such session".to_string(),
                    }];
                };
                if !state.spaces.contains(&topic) {
                    // Deny loudly: the client can tell a refusal from silence.
                    return vec![Command::Close {
                        session,
                        code: 4403,
                        reason: format!("not allowed to subscribe to {topic}"),
                    }];
                }
                state.subscriptions.insert(topic.clone());
                let cursor = *state.cursors.get(&topic).unwrap_or(&(0, 0));
                let frame = next_frame(
                    state,
                    &topic,
                    "subscribed",
                    FrameData::Subscribed { cursor },
                );
                self.topics.entry(topic).or_default().insert(session);
                vec![Command::Send { session, frame }]
            }
            Input::Signal { space, cursor } => {
                let Some(subscribers) = self.topics.get(&space).cloned() else {
                    // Nobody listening: a signal costs nothing.
                    return Vec::new();
                };
                let mut commands = Vec::with_capacity(subscribers.len());
                for session in subscribers {
                    let Some(state) = self.sessions.get_mut(&session) else {
                        continue;
                    };
                    // A signal that does not move the cursor is not news.
                    if state
                        .cursors
                        .get(&space)
                        .is_some_and(|known| *known >= cursor)
                    {
                        continue;
                    }
                    state.cursors.insert(space.clone(), cursor);
                    commands.push(Command::Send {
                        session,
                        frame: next_frame(state, &space, "changed", FrameData::Changed { cursor }),
                    });
                }
                commands
            }
            Input::Closed { session } => {
                self.sessions.remove(&session);
                for sessions in self.topics.values_mut() {
                    sessions.remove(&session);
                }
                self.topics.retain(|_, sessions| !sessions.is_empty());
                Vec::new()
            }
            Input::Backfill {
                session,
                topic,
                from,
            } => {
                let Some(state) = self.sessions.get(&session) else {
                    return vec![Command::Close {
                        session,
                        code: 4404,
                        reason: "no such session".to_string(),
                    }];
                };
                if !state.spaces.contains(&topic) {
                    return vec![Command::Close {
                        session,
                        code: 4403,
                        reason: format!("not allowed to read {topic}"),
                    }];
                }
                // The adapter reads the log between two cursors; the core only
                // decides what to ask for and where the session resumes.
                let to = state.cursors.get(&topic).copied().unwrap_or(from);
                let to = if to < from { from } else { to };
                let mut state = self.sessions.remove(&session).expect("checked above");
                let frame = next_frame(
                    &mut state,
                    &topic,
                    "backfill",
                    FrameData::Backfill { from, to },
                );
                state.cursors.insert(topic.clone(), to);
                self.sessions.insert(session, state);
                vec![
                    Command::ReadBackfill {
                        session,
                        topic: topic.clone(),
                        from,
                        to,
                    },
                    Command::Send { session, frame },
                ]
            }
        }
    }

    /// The did a session was opened for.
    pub fn did_of(&self, session: SessionId) -> Option<&str> {
        self.sessions.get(&session).map(|state| state.did.as_str())
    }
}

fn next_frame(state: &mut Session, topic: &str, kind: &'static str, data: FrameData) -> Frame {
    state.seq += 1;
    Frame {
        seq: state.seq,
        topic: topic.to_string(),
        kind,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(core: &mut SessionCore, spaces: &[&str]) -> SessionId {
        let command = core.apply(Input::Open {
            did: "did:plc:alice".to_string(),
            spaces: spaces.iter().map(|space| space.to_string()).collect(),
        });
        match command.into_iter().next().expect("a ready frame") {
            Command::Send { session, .. } => session,
            other => panic!("expected a send, got {other:?}"),
        }
    }

    fn frames(commands: Vec<Command>) -> Vec<(SessionId, Frame)> {
        commands
            .into_iter()
            .filter_map(|command| match command {
                Command::Send { session, frame } => Some((session, frame)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn subscribe_then_signal_sends_one_frame_per_change() {
        let mut core = SessionCore::new();
        let session = open(&mut core, &["did:web:space.example"]);
        let subscribed = frames(core.apply(Input::Subscribe {
            session,
            topic: "did:web:space.example".into(),
        }));
        assert_eq!(subscribed.len(), 1);
        assert_eq!(subscribed[0].1.kind, "subscribed");
        assert_eq!(subscribed[0].1.seq, 2);

        let changed = frames(core.apply(Input::Signal {
            space: "did:web:space.example".into(),
            cursor: (4, 1),
        }));
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].1.seq, 3);
        assert_eq!(changed[0].1.data, FrameData::Changed { cursor: (4, 1) });

        // The same cursor again is not news.
        assert!(frames(core.apply(Input::Signal {
            space: "did:web:space.example".into(),
            cursor: (4, 1),
        }))
        .is_empty());
    }

    #[test]
    fn a_denied_subscription_closes_the_session() {
        let mut core = SessionCore::new();
        let session = open(&mut core, &["did:web:space.example"]);
        let commands = core.apply(Input::Subscribe {
            session,
            topic: "did:web:other.example".into(),
        });
        assert_eq!(
            commands,
            vec![Command::Close {
                session,
                code: 4403,
                reason: "not allowed to subscribe to did:web:other.example".to_string(),
            }]
        );
        assert_eq!(core.subscriptions(session).count(), 0);
        assert_eq!(core.subscribers("did:web:other.example").count(), 0);
    }

    #[test]
    fn a_signal_reaches_only_its_subscribers() {
        let mut core = SessionCore::new();
        let alice = open(&mut core, &["did:web:a.example", "did:web:b.example"]);
        let bob = open(&mut core, &["did:web:b.example"]);
        core.apply(Input::Subscribe {
            session: alice,
            topic: "did:web:a.example".into(),
        });
        core.apply(Input::Subscribe {
            session: bob,
            topic: "did:web:b.example".into(),
        });

        let changed = frames(core.apply(Input::Signal {
            space: "did:web:b.example".into(),
            cursor: (1, 0),
        }));
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, bob);
        assert_eq!(
            core.subscribers("did:web:a.example").collect::<Vec<_>>(),
            vec![alice]
        );
    }

    #[test]
    fn a_reconnect_is_a_new_session_and_reuses_no_position() {
        let mut core = SessionCore::new();
        let first = open(&mut core, &["did:web:space.example"]);
        core.apply(Input::Subscribe {
            session: first,
            topic: "did:web:space.example".into(),
        });
        core.apply(Input::Signal {
            space: "did:web:space.example".into(),
            cursor: (9, 3),
        });
        core.apply(Input::Closed { session: first });

        let second = open(&mut core, &["did:web:space.example"]);
        assert_ne!(second, first);
        let subscribed = frames(core.apply(Input::Subscribe {
            session: second,
            topic: "did:web:space.example".into(),
        }));
        // A new connection restarts at seq 1+1 and knows no cursor: the client's
        // own cursor is what it resumes from.
        assert_eq!(subscribed[0].1.seq, 2);
        assert_eq!(
            subscribed[0].1.data,
            FrameData::Subscribed { cursor: (0, 0) }
        );
        assert_eq!(core.sessions(), 1);
    }

    #[test]
    fn a_backfill_asks_for_the_gap_and_resumes_there() {
        let mut core = SessionCore::new();
        let session = open(&mut core, &["did:web:space.example"]);
        core.apply(Input::Subscribe {
            session,
            topic: "did:web:space.example".into(),
        });
        core.apply(Input::Signal {
            space: "did:web:space.example".into(),
            cursor: (12, 0),
        });

        let commands = core.apply(Input::Backfill {
            session,
            topic: "did:web:space.example".into(),
            from: (5, 2),
        });
        assert_eq!(
            commands[0],
            Command::ReadBackfill {
                session,
                topic: "did:web:space.example".into(),
                from: (5, 2),
                to: (12, 0),
            }
        );
        assert_eq!(
            commands[1],
            Command::Send {
                session,
                frame: Frame {
                    seq: 4,
                    topic: "did:web:space.example".into(),
                    kind: "backfill",
                    data: FrameData::Backfill {
                        from: (5, 2),
                        to: (12, 0)
                    },
                },
            }
        );
    }

    #[test]
    fn a_backfill_from_the_future_is_clamped_to_itself() {
        let mut core = SessionCore::new();
        let session = open(&mut core, &["did:web:space.example"]);
        core.apply(Input::Subscribe {
            session,
            topic: "did:web:space.example".into(),
        });
        let commands = core.apply(Input::Backfill {
            session,
            topic: "did:web:space.example".into(),
            from: (99, 0),
        });
        assert_eq!(
            commands[0],
            Command::ReadBackfill {
                session,
                topic: "did:web:space.example".into(),
                from: (99, 0),
                to: (99, 0),
            }
        );
    }

    #[test]
    fn every_frame_on_a_session_is_numbered_in_order() {
        let mut core = SessionCore::new();
        let mut seqs: Vec<u64> = Vec::new();
        let session = match core
            .apply(Input::Open {
                did: "did:plc:alice".to_string(),
                spaces: ["did:web:space.example".to_string()].into(),
            })
            .remove(0)
        {
            Command::Send { session, frame } => {
                seqs.push(frame.seq);
                session
            }
            other => panic!("expected a send, got {other:?}"),
        };
        for command in core.apply(Input::Subscribe {
            session,
            topic: "did:web:space.example".into(),
        }) {
            if let Command::Send { frame, .. } = command {
                seqs.push(frame.seq);
            }
        }
        for idx in 1..=5 {
            for command in core.apply(Input::Signal {
                space: "did:web:space.example".into(),
                cursor: (idx, 0),
            }) {
                if let Command::Send { frame, .. } = command {
                    seqs.push(frame.seq);
                }
            }
        }
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6, 7]);
    }
}
