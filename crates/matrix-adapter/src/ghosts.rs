//! Ghost users: one Matrix user per bridged Roomy author.
//!
//! Attribution is the point of a bridge, and a ghost is the only way to get it.
//! A relay bot posting `**Alice** (via Roomy)` is a rendering trick: Matrix
//! users cannot reply to that text, mention it, invite it, or find it in the
//! member list. A ghost is a real Matrix user under the appservice's exclusive
//! namespace, so it is replyable, mentionable, and listed.
//!
//! The cost is one `m.room.member` join per participant per room, paid once.
//! Joins are lazy — a ghost joins the first time it speaks, not when the portal
//! is created — so a bridged room with 400 lurkers pays four joins, not 400.

use std::collections::BTreeMap;

use bridge_core::GhostMxid;
use roomy_events::Did;

/// A ghost the bridge has minted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhostUser {
    /// `@_roomy_<hash>:<host>`.
    pub mxid: GhostMxid,
    /// The Roomy DID behind it.
    pub did: Did,
    /// The profile name pushed to the homeserver, when one was given.
    pub display_name: Option<String>,
    /// The avatar URI pushed to the homeserver, when one was given.
    pub avatar_uri: Option<String>,
    /// Hash of the profile last pushed, so an unchanged profile is not re-sent.
    pub profile_hash: Option<String>,
}

/// Mints ghost MXIDs and remembers which Roomy DID each one belongs to.
#[derive(Debug, Clone)]
pub struct GhostRegistry {
    /// The bridge hostname ghosts live under, e.g. `matrix.roomy.local`.
    host: String,
    /// The localpart prefix, `_roomy`, matching the registration's user
    /// namespace.
    prefix: String,
    by_mxid: BTreeMap<GhostMxid, GhostUser>,
    by_did: BTreeMap<Did, GhostMxid>,
}

impl GhostRegistry {
    /// A registry that mints ghosts under `host`.
    pub fn new(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            prefix: "_roomy".into(),
            by_mxid: BTreeMap::new(),
            by_did: BTreeMap::new(),
        }
    }

    /// The MXID for `did`, minting it if this is the first message.
    ///
    /// The localpart is a truncated SHA-256 of the DID rather than a readable
    /// encoding. A DID is up to 8 KiB of arbitrary string; base32 of that is a
    /// 12 KiB localpart, past what homeservers accept. The hash is 44 bits,
    /// which collides at a probability of about 10⁻⁷ for a room of 10,000
    /// users — and a collision is caught rather than silently merging, because
    /// [`GhostRegistry::register`] refuses a localpart already taken by another
    /// DID.
    pub fn mxid_for(&self, did: &Did) -> GhostMxid {
        use sha2::{Digest, Sha256};

        let digest = Sha256::digest(did.as_str().as_bytes());
        let localpart = format!("{}_{}", self.prefix, hex_prefix(&digest, 11));
        GhostMxid::parse(format!("@{}:{}", localpart, self.host))
            .expect("minted localpart is a valid MXID")
    }

    /// Record that `did` owns `mxid`, after checking the localpart is not
    /// already someone else's.
    pub fn register(
        &mut self,
        did: &Did,
        display_name: Option<String>,
        avatar_uri: Option<String>,
    ) -> Result<GhostUser, GhostCollision> {
        if let Some(existing) = self.by_did.get(did) {
            if let Some(user) = self.by_mxid.get_mut(existing) {
                user.display_name = display_name.or_else(|| user.display_name.clone());
                user.avatar_uri = avatar_uri.or_else(|| user.avatar_uri.clone());
                return Ok(user.clone());
            }
        }

        let mxid = self.mxid_for(did);
        if let Some(owner) = self.by_mxid.get(&mxid) {
            if &owner.did != did {
                return Err(GhostCollision {
                    mxid: mxid.clone(),
                    held_by: owner.did.clone(),
                    wanted_by: did.clone(),
                });
            }
        }

        let user = GhostUser {
            mxid: mxid.clone(),
            did: did.clone(),
            display_name,
            avatar_uri,
            profile_hash: None,
        };
        self.by_mxid.insert(mxid.clone(), user.clone());
        self.by_did.insert(did.clone(), mxid);
        Ok(user)
    }

    /// The DID behind an MXID, if the bridge minted it.
    pub fn did_for(&self, mxid: &GhostMxid) -> Option<&Did> {
        self.by_mxid.get(mxid).map(|user| &user.did)
    }

    /// The MXID for a DID, if it has one.
    pub fn mxid_of(&self, did: &Did) -> Option<&GhostMxid> {
        self.by_did.get(did)
    }

    /// Record the profile hash pushed to the homeserver, so the next sync can
    /// skip an unchanged profile.
    pub fn set_profile_hash(&mut self, mxid: &GhostMxid, hash: String) {
        if let Some(user) = self.by_mxid.get_mut(mxid) {
            user.profile_hash = Some(hash);
        }
    }

    /// Every ghost the bridge knows.
    pub fn all(&self) -> impl Iterator<Item = &GhostUser> {
        self.by_mxid.values()
    }
}

/// A localpart was already taken by a different DID.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("ghost {mxid} is already minted for {held_by}, cannot give it to {wanted_by}")]
pub struct GhostCollision {
    /// The MXID both DIDs map to.
    pub mxid: GhostMxid,
    /// The DID that already owns the MXID.
    pub held_by: Did,
    /// The DID whose hash mapped to the same localpart.
    pub wanted_by: Did,
}

/// The first `count` hex characters of a digest.
fn hex_prefix(digest: &[u8], count: usize) -> String {
    let mut out = String::with_capacity(count);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
        if out.len() >= count {
            break;
        }
    }
    out.truncate(count);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn did(value: &str) -> Did {
        Did::parse(value).unwrap()
    }

    #[test]
    fn the_same_did_always_mints_the_same_mxid() {
        let registry = GhostRegistry::new("matrix.roomy.local");
        assert_eq!(
            registry.mxid_for(&did("did:plc:alice")),
            registry.mxid_for(&did("did:plc:alice"))
        );
        assert!(registry
            .mxid_for(&did("did:plc:alice"))
            .as_str()
            .starts_with("@_roomy_"));
    }

    #[test]
    fn different_dids_mint_different_mxids() {
        let registry = GhostRegistry::new("matrix.roomy.local");
        assert_ne!(
            registry.mxid_for(&did("did:plc:alice")),
            registry.mxid_for(&did("did:plc:bob"))
        );
    }

    #[test]
    fn registering_twice_updates_the_same_ghost() {
        let mut registry = GhostRegistry::new("matrix.roomy.local");
        let first = registry
            .register(&did("did:plc:alice"), Some("Alice".into()), None)
            .unwrap();
        let second = registry
            .register(
                &did("did:plc:alice"),
                Some("Alice B".into()),
                Some("atblob://x/y".into()),
            )
            .unwrap();
        assert_eq!(first.mxid, second.mxid);
        assert_eq!(second.display_name.as_deref(), Some("Alice B"));
        assert_eq!(registry.all().count(), 1);
    }

    #[test]
    fn an_mxid_resolves_back_to_its_did() {
        let mut registry = GhostRegistry::new("matrix.roomy.local");
        let ghost = registry
            .register(&did("did:plc:alice"), None, None)
            .unwrap();
        assert_eq!(registry.did_for(&ghost.mxid), Some(&did("did:plc:alice")));
        assert_eq!(registry.mxid_of(&did("did:plc:alice")), Some(&ghost.mxid));
    }

    #[test]
    fn a_collision_is_refused_rather_than_merged() {
        // A localpart already minted for one DID cannot be handed to another.
        // The registry has no way to produce a genuine 44-bit collision in a
        // test, so the occupied-mxid state is built directly — the code path
        // under test is the lookup, not the hash.
        let mut registry = GhostRegistry::new("matrix.roomy.local");
        let ghost = registry
            .register(&did("did:plc:alice"), None, None)
            .unwrap();
        // Point a different DID at the same mxid without registering it in the
        // DID index, which is what a collision would look like.
        let colliding_did = did("did:plc:impostor");
        let collision_mxid = registry.mxid_for(&colliding_did);
        registry.by_mxid.insert(
            collision_mxid.clone(),
            GhostUser {
                mxid: collision_mxid.clone(),
                did: did("did:plc:alice"),
                display_name: None,
                avatar_uri: None,
                profile_hash: None,
            },
        );

        let error = registry.register(&colliding_did, None, None).unwrap_err();
        assert_eq!(error.held_by, did("did:plc:alice"));
        assert_eq!(error.wanted_by, colliding_did);
        assert_eq!(error.mxid, collision_mxid);
        // Alice still owns her ghost.
        assert_eq!(registry.did_for(&ghost.mxid), Some(&did("did:plc:alice")));
    }
}
