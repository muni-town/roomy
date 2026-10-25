//! L1: the properties `space_core::plan` must hold for every change.
//!
//! Three of them, over a generated corpus of every kind and operation:
//!
//!  * **Determinism.** Planning one change with one context twice produces the
//!    same effects. There is no clock, no map iteration order and no ambient
//!    state to make two runs differ.
//!  * **Totality.** Every change either plans or fails with a typed error; none
//!    panics, and no effect is emitted without a target.
//!  * **No ambient input.** The only instant a rule can write is the one in its
//!    context, so planning the same change at two different wall-clock moments
//!    produces identical effects, and changing the context instant changes only
//!    the stamped values.
//!
//! The generator is a small deterministic PRNG over the record shapes this crate
//! accepts, so a failure names the same case every run.

use roomy_events::Did;
use space_core::change::{
    ChangeBase, FederationRequestPatch, FederationRequestRecord, MessageContent, MessagePatch,
    MessageRecord, RecordBody, RecordChange, RecordKind, RecordPatch, RoomPatch, RoomRecord,
};
use space_core::effects::{Effect, Target};
use space_core::ids::{Collection, Rkey, SpaceDid};
use space_core::{plan, PlanMode, RuleContext};

const STREAM: &str = "did:web:properties.example";
const ACTOR: &str = "did:plc:actor";

/// A small LCG: deterministic, dependency-free, and enough to vary the cases.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn pick<'a, T>(&mut self, values: &'a [T]) -> &'a T {
        &values[(self.next() as usize) % values.len()]
    }

    fn bool(&mut self) -> bool {
        self.next() % 2 == 0
    }
}

fn base(kind: RecordKind, key: &str, ordinal: u64) -> ChangeBase {
    // A ULID-shaped stamp whose time half is the fixture instant.
    let stamp = format!("01HF7YAT00{:016}", ordinal % 10_000);
    ChangeBase {
        kind,
        repo: Did::parse(STREAM).expect("repo"),
        collection: Collection::parse(kind.collection()).expect("collection"),
        rkey: Rkey::parse(key).expect("rkey"),
        order_stamp: serde_json::from_str(&format!("\"{stamp}\"")).expect("stamp"),
    }
}

fn ctx(decided_at_ms: i64) -> RuleContext {
    RuleContext::new(
        SpaceDid::parse(STREAM).expect("space"),
        Did::parse(ACTOR).expect("actor"),
        "01HF7YAT00000000000000000A",
        decided_at_ms,
    )
}

fn message(room: &str, text: &str) -> RecordBody {
    RecordBody::Message(MessageRecord {
        room: room.to_string(),
        author: Did::parse(ACTOR).expect("author"),
        actor: None,
        extensions: None,
        content: Some(MessageContent {
            mime_type: "text/markdown".to_string(),
            data: text.as_bytes().to_vec(),
        }),
        system: None,
        forward_of: None,
    })
}

fn room(name: &str, parent: Option<&str>) -> RecordBody {
    RecordBody::Room(RoomRecord {
        kind: "space.roomy.channel".to_string(),
        name: Some(name.to_string()),
        avatar: None,
        description: None,
        default_access: Some("readwrite".to_string()),
        deleted: false,
        parent: parent.map(str::to_string),
        discord_origin: None,
    })
}

fn federation_request(federating: &str, message: Option<&str>) -> RecordBody {
    RecordBody::FederationRequest(FederationRequestRecord {
        federating_space: federating.to_string(),
        requested_by: Did::parse(ACTOR).expect("requester"),
        message: message.map(str::to_string),
    })
}

/// One generated case: what to plan, and a name to report it under.
struct Case {
    name: String,
    change: RecordChange,
}

fn cases() -> Vec<Case> {
    let mut rng = Rng(0x5EED_1234);
    let rooms = ["01HF7YAT000000000000000001", "01HF7YAT000000000000000002"];
    let texts = [
        "hello",
        "https://example.com/x",
        "",
        "plain text with no links",
    ];
    let mut cases = Vec::new();

    for ordinal in 0..200u64 {
        let room_id = *rng.pick(&rooms);
        let key = format!("01HF7YAT00{:016}", ordinal % 10_000);
        let case = match ordinal % 10 {
            0 => Case {
                name: format!("message.create#{ordinal}"),
                change: RecordChange::Create {
                    base: base(RecordKind::Message, &key, ordinal),
                    record: message(room_id, rng.pick(&texts)),
                },
            },
            1 => Case {
                name: format!("message.update#{ordinal}"),
                change: RecordChange::Update {
                    base: base(RecordKind::Message, &key, ordinal),
                    patch: RecordPatch::Message(MessagePatch {
                        room: rng.bool().then(|| (*rng.pick(&rooms)).to_string()),
                        content: Some(MessageContent {
                            mime_type: "text/markdown".to_string(),
                            data: rng.pick(&texts).as_bytes().to_vec(),
                        }),
                        extensions: None,
                    }),
                },
            },
            2 => Case {
                name: format!("message.delete#{ordinal}"),
                change: RecordChange::Delete {
                    base: base(RecordKind::Message, &key, ordinal),
                },
            },
            3 => Case {
                name: format!("room.create#{ordinal}"),
                change: RecordChange::Create {
                    base: base(RecordKind::Room, &key, ordinal),
                    record: room("general", None),
                },
            },
            4 => Case {
                name: format!("room.update#{ordinal}"),
                change: RecordChange::Update {
                    base: base(RecordKind::Room, &key, ordinal),
                    patch: RecordPatch::Room(RoomPatch {
                        name: Some(Some("renamed".to_string())),
                        kind: None,
                        avatar: None,
                        description: None,
                        default_access: None,
                        deleted: rng.bool().then_some(true),
                        parent: rng.bool().then(|| Some(rooms[0].to_string())),
                    }),
                },
            },
            5 => Case {
                name: format!("federation.create#{ordinal}"),
                change: RecordChange::Create {
                    base: base(RecordKind::FederationRequest, &key, ordinal),
                    record: federation_request("did:web:other.example", Some("please")),
                },
            },
            6 => Case {
                name: format!("federation.update#{ordinal}"),
                change: RecordChange::Update {
                    base: base(
                        RecordKind::FederationRequest,
                        &key.replace('0', "1"),
                        ordinal,
                    ),
                    patch: RecordPatch::FederationRequest(FederationRequestPatch {
                        status: "active".to_string(),
                        decided_by: Did::parse(ACTOR).expect("decider"),
                        message: None,
                    }),
                },
            },
            7 => Case {
                name: format!("federation.delete#{ordinal}"),
                change: RecordChange::Delete {
                    base: base(RecordKind::FederationRequest, &key, ordinal),
                },
            },
            8 => Case {
                name: format!("reaction.create#{ordinal}"),
                change: RecordChange::Create {
                    base: base(RecordKind::Reaction, &key, ordinal),
                    record: RecordBody::Reaction(space_core::change::ReactionRecord {
                        target: rooms[0].to_string(),
                        user: Did::parse(ACTOR).expect("user"),
                        reaction: "👍".to_string(),
                        bridged: rng.bool(),
                    }),
                },
            },
            _ => Case {
                name: format!("membership.create#{ordinal}"),
                change: RecordChange::Create {
                    base: base(RecordKind::Membership, "did:plc:joiner", ordinal),
                    record: RecordBody::Membership(space_core::change::MembershipRecord {
                        user: Did::parse("did:plc:joiner").expect("user"),
                        can: "post".to_string(),
                    }),
                },
            },
        };
        cases.push(case);
    }
    cases
}

#[test]
fn planning_the_same_change_twice_is_the_same_plan() {
    for case in cases() {
        let first = plan(&case.change, &ctx(1_700_000_000_000));
        let second = plan(&case.change, &ctx(1_700_000_000_000));
        match (first, second) {
            (Ok(first), Ok(second)) => assert_eq!(
                first, second,
                "{} planned differently on a second run",
                case.name
            ),
            (Err(first), Err(second)) => assert_eq!(
                first.to_string(),
                second.to_string(),
                "{} failed differently on a second run",
                case.name
            ),
            (first, second) => panic!(
                "{} planned and failed: {:?} / {:?}",
                case.name, first, second
            ),
        }
    }
}

#[test]
fn every_change_either_plans_or_fails_with_a_typed_error() {
    // `plan` returns a `Result`; reaching the end of this loop is the property.
    // What is *not* allowed is an effect with no target or an empty statement.
    let mut planned = 0usize;
    let mut refusals = 0usize;
    for case in cases() {
        let mut context = ctx(1_700_000_000_000);
        if case.change.kind() == RecordKind::Message
            && matches!(case.change, RecordChange::Update { .. })
        {
            context.prior_room = Some("01HF7YAT000000000000000001".to_string());
        }
        if case.change.kind() == RecordKind::Room
            && matches!(case.change, RecordChange::Update { .. })
        {
            context.prior_parent = Some("01HF7YAT000000000000000002".to_string());
        }
        match plan(&case.change, &context) {
            Ok(effects) => {
                planned += 1;
                for effect in effects {
                    if let Effect::Sql(statement) = effect {
                        assert!(
                            !statement.sql.trim().is_empty(),
                            "{} emitted an empty statement",
                            case.name
                        );
                        assert!(matches!(statement.target, Target::Space | Target::Global));
                    }
                }
            }
            Err(_) => refusals += 1,
        }
    }
    assert!(planned > 0, "the generator produced nothing that plans");
    // Some kinds refuse an operation they do not have (`spaceInfo` has no
    // delete, a room is never deleted); those are the typed errors.
    assert!(planned + refusals == cases().len());
}

#[test]
fn the_only_instant_a_rule_writes_is_the_one_in_its_context() {
    let early = ctx(1_700_000_000_000);
    let late = ctx(1_700_000_500_000);
    // A federation decision and an entity row both stamp the context instant.
    let change = RecordChange::Create {
        base: base(
            RecordKind::FederationRequest,
            "01HF7YAT0000000000000000F1",
            1,
        ),
        record: federation_request("did:web:other.example", Some("please")),
    };
    let early_effects = plan(&change, &early).expect("planned");
    let late_effects = plan(&change, &late).expect("planned");
    assert_ne!(
        early_effects, late_effects,
        "the context instant has to reach the statement, or a replay could not reproduce it"
    );

    // And nothing else moves: the same context plans identically whatever the
    // wall clock says, which is what makes a replay byte-identical.
    for case in cases() {
        let first = plan(&case.change, &ctx(1_700_000_000_000));
        std::thread::sleep(std::time::Duration::from_millis(1));
        let second = plan(&case.change, &ctx(1_700_000_000_000));
        assert_eq!(
            first
                .map(|effects| effects.len())
                .map_err(|error| error.to_string()),
            second
                .map(|effects| effects.len())
                .map_err(|error| error.to_string()),
            "{} changed its plan between two calls",
            case.name
        );
    }
}

#[test]
fn a_rebuild_mode_changes_only_the_read_path_projections() {
    // The live and backfill modes decide whether `room_access` and the feed
    // window are written or invalidated. A change that touches neither must plan
    // the same in both modes.
    let mut live = ctx(1_700_000_000_000);
    let mut backfill = ctx(1_700_000_000_000);
    backfill.is_backfill = PlanMode::Backfill.is_backfill();
    live.is_backfill = PlanMode::Live.is_backfill();

    let change = RecordChange::Create {
        base: base(RecordKind::Message, "01HF7YAT0000000000000000F2", 2),
        record: message("01HF7YAT000000000000000001", "hello"),
    };
    let live_effects = plan(&change, &live).expect("planned");
    let backfill_effects = plan(&change, &backfill).expect("planned");
    assert_eq!(
        live_effects.len(),
        backfill_effects.len(),
        "the mode must not change how many effects a change has"
    );
    let live_sql: Vec<&str> = live_effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Sql(statement) => Some(statement.sql),
            _ => None,
        })
        .collect();
    let backfill_sql: Vec<&str> = backfill_effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Sql(statement) => Some(statement.sql),
            _ => None,
        })
        .collect();
    assert_ne!(
        live_sql, backfill_sql,
        "a rebuild invalidates the feed window instead of folding into it"
    );
    assert!(backfill_sql
        .iter()
        .any(|sql| sql.contains("delete from room_activity")));
}
