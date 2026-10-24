//! Homeserver capability probe.
//!
//! An appservice can only decrypt room events if the homeserver delivers the
//! pieces encryption needs: to-device messages (MSC4203), device lists and
//! one-time-key counts in `/transactions` (MSC3202), and appservice-side device
//! creation (MSC4190). A fourth stream — ephemeral typing, receipt and presence
//! events (MSC2409) — is not what room keys travel on, so it is measured
//! separately from the gate: the report says whether the homeserver pushes it,
//! and no encrypted room depends on the answer. Homeserver support varies, and
//! "does it work" is a measurement rather than a claim, so every check here is a
//! call the bridge would make anyway.
//!
//! The three MSC3202 fields are reported one verdict each, because a homeserver
//! can send some and not others: device lists say when a ghost's keys changed,
//! one-time-key counts say when to upload more, and fallback key types say
//! whether keys survive an exhausted pool.
//!
//! Two facts shape the probes:
//!
//! * **MSC3202, MSC4203 and MSC2409 are still unstable.** Synapse emits them
//!   under `org.matrix.msc3202.*`, `de.sorunome.msc2409.to_device` and
//!   `de.sorunome.msc2409.ephemeral` — the to-device field kept the MSC2409
//!   spelling when MSC4203 moved it out — while a stabilised homeserver would
//!   use the bare names. Both spellings are checked, because a bridge that only
//!   looked for one would report a working homeserver as broken.
//! * **`/versions` is not the signal.** Synapse does not advertise either MSC
//!   there; it enables them per registration. So the authoritative evidence is
//!   the transaction body the homeserver actually pushes and the device call it
//!   actually answers.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::transport::HomeserverClient;

/// The `ephemeral` field names a homeserver may use.
pub const EPHEMERAL_KEYS: &[&str] = &["ephemeral", "de.sorunome.msc2409.ephemeral"];

/// The `to_device` field names a homeserver may use.
pub const TO_DEVICE_KEYS: &[&str] = &["to_device", "de.sorunome.msc2409.to_device"];

/// The MSC3202 `device_lists` field names a homeserver may use.
pub const DEVICE_LIST_KEYS: &[&str] = &["device_lists", "org.matrix.msc3202.device_lists"];

/// The MSC3202 `device_one_time_keys_count` field names a homeserver may use.
pub const OTK_COUNT_KEYS: &[&str] = &[
    "device_one_time_keys_count",
    "org.matrix.msc3202.device_one_time_keys_count",
];

/// The MSC3202 `device_unused_fallback_key_types` field names a homeserver may
/// use.
pub const FALLBACK_KEY_KEYS: &[&str] = &[
    "device_unused_fallback_key_types",
    "org.matrix.msc3202.device_unused_fallback_key_types",
];

/// Every MSC3202 transaction extension field name a homeserver may use.
pub const MSC3202_KEYS: &[&str] = &[
    "device_lists",
    "org.matrix.msc3202.device_lists",
    "device_one_time_keys_count",
    "org.matrix.msc3202.device_one_time_keys_count",
    "device_unused_fallback_key_types",
    "org.matrix.msc3202.device_unused_fallback_key_types",
];

/// Whether one MSC is implemented, and how the probe found out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum MscStatus {
    /// The homeserver demonstrated the feature.
    Pass { evidence: String },
    /// The homeserver does not have the feature.
    Fail { evidence: String },
}

impl MscStatus {
    pub fn passed(&self) -> bool {
        matches!(self, MscStatus::Pass { .. })
    }

    /// The observation behind the verdict, for the health report.
    pub fn evidence(&self) -> &str {
        match self {
            MscStatus::Pass { evidence } | MscStatus::Fail { evidence } => evidence,
        }
    }
}

/// The capabilities the probe measures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HomeserverCapabilities {
    /// MSC4190: the appservice may create and manage devices.
    pub msc4190_devices: MscStatus,
    /// MSC2409: `/transactions` carries the `ephemeral` stream.
    pub msc2409_ephemeral: MscStatus,
    /// MSC4203: `/transactions` carries the `to_device` stream.
    pub msc4203_to_device: MscStatus,
    /// MSC3202: `/transactions` carries device-list changes.
    pub msc3202_device_lists: MscStatus,
    /// MSC3202: `/transactions` carries one-time-key counts.
    pub msc3202_otk_counts: MscStatus,
    /// MSC3202: `/transactions` carries unused fallback key types.
    pub msc3202_fallback_keys: MscStatus,
    /// What the homeserver reported at `/versions`, for the report.
    pub server_version: Option<String>,
}

/// The features end-to-bridge encryption cannot run without.
///
/// Ephemeral events carry no key material, and fallback keys only decide what
/// happens once the one-time-key pool is exhausted, so neither gates encryption
/// — both are still reported, because "does this homeserver do MSC2409" is a
/// question an operator asks and the report is the only place it is answered.
const E2EE_FEATURES: &[&str] = &[
    "msc4190-devices",
    "msc4203-to-device",
    "msc3202-device-lists",
    "msc3202-otk-counts",
];

impl HomeserverCapabilities {
    /// Every measured feature with its verdict, in report order.
    ///
    /// One list, so the CLI report and the admin API cannot drift apart.
    pub fn features(&self) -> [(&'static str, &MscStatus); 6] {
        [
            ("msc4190-devices", &self.msc4190_devices),
            ("msc2409-ephemeral", &self.msc2409_ephemeral),
            ("msc4203-to-device", &self.msc4203_to_device),
            ("msc3202-device-lists", &self.msc3202_device_lists),
            ("msc3202-otk-counts", &self.msc3202_otk_counts),
            ("msc3202-fallback-keys", &self.msc3202_fallback_keys),
        ]
    }

    /// Whether the homeserver delivers everything encryption needs.
    pub fn e2ee_available(&self) -> bool {
        self.missing().is_empty()
    }

    /// The encryption features that failed, named for an operator.
    pub fn missing(&self) -> Vec<&'static str> {
        self.features()
            .into_iter()
            .filter(|(name, status)| E2EE_FEATURES.contains(name) && !status.passed())
            .map(|(name, _)| name)
            .collect()
    }

    /// A one-line-per-feature report, as `--check-homeserver` prints it.
    pub fn report(&self) -> String {
        let mut out = String::new();
        if let Some(version) = &self.server_version {
            out.push_str(&format!("homeserver: {version}\n"));
        }
        for (name, status) in self.features() {
            let verdict = if status.passed() { "pass" } else { "fail" };
            out.push_str(&format!("{name}: {verdict} ({})\n", status.evidence()));
        }
        out.push_str(&format!(
            "e2ee: {}\n",
            if self.e2ee_available() {
                "available"
            } else {
                "unavailable"
            }
        ));
        out
    }
}

/// What a transaction the homeserver pushed actually contained.
///
/// Kept as the top-level key set plus the stream counts, because that is exactly
/// the evidence the MSC3202, MSC4203 and MSC2409 checks need and nothing else is
/// required.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservedTransaction {
    /// Every top-level key the transaction body carried.
    pub keys: Vec<String>,
    /// How many to-device messages it carried.
    pub to_device_count: usize,
    /// How many ephemeral events it carried.
    pub ephemeral_count: usize,
}

impl ObservedTransaction {
    /// Read a transaction body.
    pub fn from_body(body: &serde_json::Value) -> Self {
        let keys = body
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        // The first spelling present wins: a homeserver that sends both the
        // stable and the unstable key must not be counted twice.
        let count = |candidates: &[&str]| -> usize {
            candidates
                .iter()
                .find_map(|key| body.get(*key).and_then(|value| value.as_array()))
                .map(|events| events.len())
                .unwrap_or_default()
        };
        Self {
            keys,
            to_device_count: count(TO_DEVICE_KEYS),
            ephemeral_count: count(EPHEMERAL_KEYS),
        }
    }

    /// Whether any key matching `candidates` is present.
    fn has_any(&self, candidates: &[&str]) -> Option<String> {
        candidates
            .iter()
            .find(|candidate| self.keys.iter().any(|key| key == *candidate))
            .map(|key| (*key).to_string())
    }

    /// Fold a later transaction's evidence into this one.
    ///
    /// Keys are unioned and the stream counts summed, because a capability shown
    /// by any single transaction is a capability the homeserver has. Evidence
    /// only ever accumulates: a homeserver that stops sending a field has still
    /// been measured as supporting it.
    pub fn merge(&mut self, later: Self) {
        for key in later.keys {
            if !self.keys.contains(&key) {
                self.keys.push(key);
            }
        }
        self.to_device_count += later.to_device_count;
        self.ephemeral_count += later.ephemeral_count;
    }

    /// Whether every stream the probe waits for has been seen.
    ///
    /// All of them, not any: a homeserver that sends the MSC3202 fields one at a
    /// time would otherwise be measured after the first, and the rest reported
    /// as absent when they were merely later. Fallback-key types are not waited
    /// for — Synapse sends them with the other two MSC3202 fields, and waiting
    /// out the deadline for a field no encryption path depends on would delay
    /// every start.
    pub fn has_probed_streams(&self) -> bool {
        self.has_any(EPHEMERAL_KEYS).is_some()
            && self.has_any(TO_DEVICE_KEYS).is_some()
            && self.has_any(DEVICE_LIST_KEYS).is_some()
            && self.has_any(OTK_COUNT_KEYS).is_some()
    }
}

/// The probe's shared state: what this homeserver has actually sent across
/// every transaction the appservice received.
///
/// Shared between the HTTP server (which sees every transaction) and the probe
/// (which reads them), so `/capabilities` reports what this homeserver actually
/// sent rather than what it claims to support.
///
/// Transactions are accumulated rather than replaced. A homeserver batches on a
/// timer, so the state events for a room and the to-device message that follows
/// them arrive in different transactions; keeping only the last one would
/// discard the evidence MSC3202 needs and report a working homeserver as broken.
#[derive(Debug, Clone, Default)]
pub struct TransactionObserver {
    observed: Arc<Mutex<Option<ObservedTransaction>>>,
}

impl TransactionObserver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a transaction the server received, merging it into what earlier
    /// transactions showed.
    pub fn observe(&self, body: &serde_json::Value) {
        let observed = ObservedTransaction::from_body(body);
        let mut slot = self.observed.lock();
        match slot.as_mut() {
            Some(accumulated) => accumulated.merge(observed),
            None => *slot = Some(observed),
        }
    }

    /// Everything observed so far, if any traffic has arrived.
    pub fn last(&self) -> Option<ObservedTransaction> {
        self.observed.lock().clone()
    }
}

/// Runs the probe against a live homeserver.
pub struct CapabilityProbe {
    homeserver: HomeserverClient,
    /// The appservice's own user, whose device the MSC4190 check creates.
    sender_localpart: String,
    domain: String,
    observer: TransactionObserver,
}

impl CapabilityProbe {
    pub fn new(
        homeserver: HomeserverClient,
        sender_localpart: impl Into<String>,
        domain: impl Into<String>,
        observer: TransactionObserver,
    ) -> Self {
        Self {
            homeserver,
            sender_localpart: sender_localpart.into(),
            domain: domain.into(),
            observer,
        }
    }

    /// Measure the homeserver.
    pub async fn run(&self) -> HomeserverCapabilities {
        let server_version = self.server_version().await;
        let msc4190_devices = self.probe_device_management().await;
        let msc2409_ephemeral = self.probe_ephemeral();
        let msc4203_to_device = self.probe_to_device();
        let msc3202_device_lists = self.probe_transaction_field(DEVICE_LIST_KEYS, "device lists");
        let msc3202_otk_counts =
            self.probe_transaction_field(OTK_COUNT_KEYS, "one-time-key counts");
        let msc3202_fallback_keys =
            self.probe_transaction_field(FALLBACK_KEY_KEYS, "fallback key types");

        HomeserverCapabilities {
            msc4190_devices,
            msc2409_ephemeral,
            msc4203_to_device,
            msc3202_device_lists,
            msc3202_otk_counts,
            msc3202_fallback_keys,
            server_version,
        }
    }

    /// What the homeserver reports about itself, for the report.
    async fn server_version(&self) -> Option<String> {
        let versions = self.homeserver.versions().await.ok()?;
        versions
            .get("server_version")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    }

    /// MSC4190 is decided by creating a device as the appservice's own user.
    ///
    /// The appservice owns its sender localpart, so this is exactly the call the
    /// bridge makes to install a ghost device — and the only one that separates
    /// "implements MSC4190" from "advertises it".
    async fn probe_device_management(&self) -> MscStatus {
        let user_id = format!("@{}:{}", self.sender_localpart, self.domain);
        let device_id = format!("ROOMYPROBE{}", ulid::Ulid::generate());

        match self
            .homeserver
            .ensure_device(&user_id, &device_id, "roomy bridge capability probe")
            .await
        {
            Ok(()) => {
                // Remove the probe device so repeated runs do not accumulate them.
                let _ = self.homeserver.delete_device(&user_id, &device_id).await;
                MscStatus::Pass {
                    evidence: "PUT /devices answered HTTP 200 and the device was created".into(),
                }
            }
            Err(error) => MscStatus::Fail {
                evidence: format!("PUT /devices could not create a device: {error}"),
            },
        }
    }

    /// MSC2409 is decided by the `ephemeral` field on a transaction.
    fn probe_ephemeral(&self) -> MscStatus {
        match self.observer.last() {
            Some(transaction) => match transaction.has_any(EPHEMERAL_KEYS) {
                Some(key) => MscStatus::Pass {
                    evidence: format!(
                        "transactions carried {key} with {} event(s)",
                        transaction.ephemeral_count
                    ),
                },
                None => MscStatus::Fail {
                    evidence: format!(
                        "transactions carried only [{}] — no ephemeral stream",
                        transaction.keys.join(", ")
                    ),
                },
            },
            None => MscStatus::Fail {
                evidence: "no transaction has been delivered yet, so the ephemeral stream \
                           could not be observed"
                    .to_string(),
            },
        }
    }

    /// MSC4203 is decided by the `to_device` field on a transaction.
    fn probe_to_device(&self) -> MscStatus {
        match self.observer.last() {
            Some(transaction) => match transaction.has_any(TO_DEVICE_KEYS) {
                Some(key) => MscStatus::Pass {
                    evidence: format!(
                        "transactions carried {key} with {} message(s)",
                        transaction.to_device_count
                    ),
                },
                None => MscStatus::Fail {
                    evidence: format!(
                        "transactions carried only [{}] — no to-device stream",
                        transaction.keys.join(", ")
                    ),
                },
            },
            None => MscStatus::Fail {
                evidence: "no transaction has been delivered yet, so the to-device stream \
                           could not be observed"
                    .to_string(),
            },
        }
    }

    /// One MSC3202 field is decided by the key the homeserver actually puts on a
    /// transaction.
    fn probe_transaction_field(&self, candidates: &[&str], field: &str) -> MscStatus {
        match self.observer.last() {
            Some(transaction) => match transaction.has_any(candidates) {
                Some(key) => MscStatus::Pass {
                    evidence: format!("transactions carried {key}"),
                },
                None => MscStatus::Fail {
                    evidence: format!(
                        "transactions carried only [{}] — no {field}",
                        transaction.keys.join(", ")
                    ),
                },
            },
            None => MscStatus::Fail {
                evidence: format!(
                    "no transaction has been delivered yet, so the {field} field could not be \
                     observed"
                ),
            },
        }
    }
}

/// The MSC3202 extension fields, for the server's transaction parser.
pub fn transaction_extension_keys(body: &serde_json::Value) -> Vec<String> {
    MSC3202_KEYS
        .iter()
        .filter(|key| body.get(**key).is_some())
        .map(|key| (*key).to_string())
        .collect()
}

/// The to-device messages a transaction carries, under either field name.
pub fn transaction_to_device(body: &serde_json::Value) -> Vec<serde_json::Value> {
    TO_DEVICE_KEYS
        .iter()
        .find_map(|key| body.get(*key).and_then(|value| value.as_array()))
        .into_iter()
        .flatten()
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::transport::{fake_client, FakeHomeserver, FakeResponse, Method};

    #[tokio::test]
    async fn the_probe_creates_a_device_as_the_appservice_user_and_removes_it() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Get,
            "/_matrix/client/versions",
            FakeResponse::ok(json!({ "server_version": "Synapse/1.99", "versions": [] })),
        );
        fake.route(
            Method::Put,
            "/_matrix/client/v3/devices/",
            FakeResponse::ok(json!({})),
        );
        fake.route(
            Method::Delete,
            "/_matrix/client/v3/devices/",
            FakeResponse::ok(json!({})),
        );

        let capabilities = CapabilityProbe::new(
            fake_client(&fake),
            "_roomy_bridge",
            "hs.test",
            TransactionObserver::new(),
        )
        .run()
        .await;

        assert!(capabilities.msc4190_devices.passed());
        assert_eq!(capabilities.server_version.as_deref(), Some("Synapse/1.99"));
        // The stream checks rest on transactions, and none arrived.
        assert!(!capabilities.msc2409_ephemeral.passed());

        let requests = fake.requests();
        assert_eq!(requests[0].url, "http://hs.test/_matrix/client/versions");
        assert!(
            requests[1]
                .url
                .contains("/_matrix/client/v3/devices/ROOMYPROBE"),
            "the probe creates a device of its own: {}",
            requests[1].url
        );
        assert!(
            requests[1]
                .url
                .contains("user_id=%40_roomy_bridge%3Ahs.test"),
            "the device belongs to the appservice's own user: {}",
            requests[1].url
        );
        assert_eq!(requests[2].method, Method::Delete);
        assert!(
            requests[2].url.contains("/ROOMYPROBE"),
            "the probe removes the device it created: {}",
            requests[2].url
        );
    }

    #[tokio::test]
    async fn a_refused_device_creation_reports_the_status_it_answered() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Get,
            "/_matrix/client/versions",
            FakeResponse::ok(json!({})),
        );
        fake.route(
            Method::Put,
            "/_matrix/client/v3/devices/",
            FakeResponse::refusing(403, "M_FORBIDDEN"),
        );

        let capabilities = CapabilityProbe::new(
            fake_client(&fake),
            "_roomy_bridge",
            "hs.test",
            TransactionObserver::new(),
        )
        .run()
        .await;

        assert!(!capabilities.msc4190_devices.passed());
        assert!(
            capabilities.msc4190_devices.evidence().contains("403"),
            "the evidence names the status: {}",
            capabilities.msc4190_devices.evidence()
        );
        assert_eq!(
            fake.requests().len(),
            2,
            "a refused creation has nothing to remove"
        );
    }

    fn all_pass() -> HomeserverCapabilities {
        HomeserverCapabilities {
            msc4190_devices: MscStatus::Pass {
                evidence: "PUT /devices answered HTTP 201".into(),
            },
            msc2409_ephemeral: MscStatus::Pass {
                evidence: "transactions carried ephemeral with 1 event(s)".into(),
            },
            msc4203_to_device: MscStatus::Pass {
                evidence: "transactions carried de.sorunome.msc2409.to_device with 1 message(s)"
                    .into(),
            },
            msc3202_device_lists: MscStatus::Pass {
                evidence: "transactions carried org.matrix.msc3202.device_lists".into(),
            },
            msc3202_otk_counts: MscStatus::Pass {
                evidence: "transactions carried org.matrix.msc3202.device_one_time_keys_count"
                    .into(),
            },
            msc3202_fallback_keys: MscStatus::Pass {
                evidence: "transactions carried \
                           org.matrix.msc3202.device_unused_fallback_key_types"
                    .into(),
            },
            server_version: Some("Synapse/1.99".into()),
        }
    }

    #[test]
    fn e2ee_needs_the_key_streams_and_device_management() {
        assert!(all_pass().e2ee_available());

        let mut capabilities = all_pass();
        capabilities.msc4203_to_device = MscStatus::Fail {
            evidence: "not observed".into(),
        };
        assert!(!capabilities.e2ee_available());
        assert_eq!(capabilities.missing(), vec!["msc4203-to-device"]);

        let mut capabilities = all_pass();
        capabilities.msc3202_otk_counts = MscStatus::Fail {
            evidence: "not observed".into(),
        };
        assert_eq!(capabilities.missing(), vec!["msc3202-otk-counts"]);
    }

    #[test]
    fn the_streams_encryption_does_not_need_are_reported_but_do_not_gate_it() {
        let mut capabilities = all_pass();
        capabilities.msc2409_ephemeral = MscStatus::Fail {
            evidence: "not observed".into(),
        };
        capabilities.msc3202_fallback_keys = MscStatus::Fail {
            evidence: "not observed".into(),
        };
        assert!(capabilities.e2ee_available());
        assert!(capabilities.missing().is_empty());
        // Reported all the same: an operator reads them, and the report is the
        // only place a fail shows.
        assert!(capabilities
            .report()
            .contains("msc2409-ephemeral: fail (not observed)"));
        assert!(capabilities
            .report()
            .contains("msc3202-fallback-keys: fail (not observed)"));
    }

    #[test]
    fn the_report_names_every_feature_and_its_verdict() {
        let mut capabilities = all_pass();
        capabilities.msc3202_device_lists = MscStatus::Fail {
            evidence: "transactions carried only [events]".into(),
        };
        let report = capabilities.report();
        assert!(report.contains("msc4190-devices: pass"));
        assert!(report.contains("msc2409-ephemeral: pass"));
        assert!(report.contains("msc4203-to-device: pass"));
        assert!(report.contains("msc3202-device-lists: fail (transactions carried only [events])"));
        assert!(report.contains("msc3202-otk-counts: pass"));
        assert!(report.contains("msc3202-fallback-keys: pass"));
        assert!(report.contains("e2ee: unavailable"));
        assert_eq!(capabilities.features().len(), 6);
    }

    #[test]
    fn an_unobserved_transaction_fails_rather_than_defaulting_to_pass() {
        let capabilities = HomeserverCapabilities {
            msc4190_devices: MscStatus::Pass {
                evidence: "x".into(),
            },
            msc2409_ephemeral: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            msc4203_to_device: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            msc3202_device_lists: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            msc3202_otk_counts: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            msc3202_fallback_keys: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            server_version: None,
        };
        assert!(!capabilities.e2ee_available());
    }

    #[test]
    fn the_unstable_synapse_keys_are_recognised() {
        let body = json!({
            "events": [],
            "ephemeral": [{ "type": "m.typing" }],
            "de.sorunome.msc2409.to_device": [{ "type": "m.room.encrypted" }],
            "org.matrix.msc3202.device_lists": { "changed": [], "left": [] },
            "org.matrix.msc3202.device_one_time_keys_count": {},
        });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 1);
        assert_eq!(transaction.ephemeral_count, 1);
        assert_eq!(
            transaction.has_any(EPHEMERAL_KEYS).as_deref(),
            Some("ephemeral")
        );
        assert!(transaction.has_any(TO_DEVICE_KEYS).is_some());
        assert!(transaction.has_any(MSC3202_KEYS).is_some());
        assert_eq!(
            transaction_extension_keys(&body),
            vec![
                "org.matrix.msc3202.device_lists",
                "org.matrix.msc3202.device_one_time_keys_count"
            ]
        );
        assert_eq!(transaction_to_device(&body).len(), 1);
    }

    #[test]
    fn each_msc3202_field_is_recognised_on_its_own() {
        let body = json!({
            "events": [],
            "org.matrix.msc3202.device_one_time_keys_count": {
                "@_roomy_bridge:matrix.roomy.local": { "PROBE": { "signed_curve25519": 3 } }
            },
        });
        let transaction = ObservedTransaction::from_body(&body);
        assert!(transaction.has_any(OTK_COUNT_KEYS).is_some());
        assert!(transaction.has_any(DEVICE_LIST_KEYS).is_none());
        assert!(transaction.has_any(FALLBACK_KEY_KEYS).is_none());
    }

    #[test]
    fn the_unstable_ephemeral_key_is_recognised_and_not_double_counted() {
        // Older Synapse sends the prefixed spelling, newer sends both.
        let unstable = json!({
            "events": [],
            "de.sorunome.msc2409.ephemeral": [{ "type": "m.typing" }],
        });
        let transaction = ObservedTransaction::from_body(&unstable);
        assert_eq!(transaction.ephemeral_count, 1);
        assert_eq!(
            transaction.has_any(EPHEMERAL_KEYS).as_deref(),
            Some("de.sorunome.msc2409.ephemeral")
        );

        let both = json!({
            "events": [],
            "ephemeral": [{ "type": "m.typing" }],
            "de.sorunome.msc2409.ephemeral": [{ "type": "m.typing" }],
        });
        assert_eq!(ObservedTransaction::from_body(&both).ephemeral_count, 1);
    }

    #[test]
    fn the_wait_ends_only_once_every_probed_stream_has_been_seen() {
        let observer = TransactionObserver::new();
        observer.observe(&json!({
            "events": [],
            "ephemeral": [{ "type": "m.typing" }],
            "de.sorunome.msc2409.to_device": [],
            "org.matrix.msc3202.device_lists": { "changed": [], "left": [] },
        }));
        // The fields arrive across several transactions; the one-time-key counts
        // are still outstanding, so the probe keeps waiting rather than measuring
        // a partial set.
        assert!(!observer.last().unwrap().has_probed_streams());

        observer.observe(&json!({
            "events": [],
            "org.matrix.msc3202.device_one_time_keys_count": {},
        }));
        assert!(observer.last().unwrap().has_probed_streams());
    }

    #[test]
    fn the_stable_keys_are_recognised_too() {
        let body = json!({
            "events": [],
            "to_device": [{ "type": "m.room.encrypted" }, { "type": "m.room_key" }],
            "device_lists": { "changed": [], "left": [] },
        });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 2);
        assert_eq!(
            transaction.has_any(TO_DEVICE_KEYS).as_deref(),
            Some("to_device")
        );
        assert_eq!(
            transaction.has_any(MSC3202_KEYS).as_deref(),
            Some("device_lists")
        );
    }

    #[test]
    fn a_homeserver_with_only_events_fails_every_stream_check() {
        // What a homeserver without the appservice extensions sends: PDUs and
        // nothing else.
        let body = json!({ "events": [{ "type": "m.room.message" }] });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 0);
        assert_eq!(transaction.ephemeral_count, 0);
        assert!(transaction.has_any(EPHEMERAL_KEYS).is_none());
        assert!(transaction.has_any(TO_DEVICE_KEYS).is_none());
        assert!(transaction.has_any(MSC3202_KEYS).is_none());
    }

    #[test]
    fn the_observer_accumulates_transactions() {
        let observer = TransactionObserver::new();
        assert!(observer.last().is_none());
        observer.observe(&json!({ "events": [], "to_device": [] }));
        assert!(observer.last().is_some());
        assert_eq!(observer.last().unwrap().to_device_count, 0);
    }
}
