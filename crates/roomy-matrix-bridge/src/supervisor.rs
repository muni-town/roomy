//! The outbound direction and backfill: Roomy → Matrix, and Matrix history →
//! Roomy.
//!
//! Outbound reads the appserver's sync socket for each bridged space. Every
//! event whose origin is not Matrix and whose author is not the bridge is sent
//! to Matrix as the author's ghost. An author with no Matrix counterpart is sent
//! as the bridge's own user, because dropping the message would hide it — the
//! plan's rule is "otherwise as the bridge's own user with a note in the body".
//!
//! Backfill is two-phase, and only ever Matrix → Roomy. A new portal takes a
//! capped recent window synchronously so the channel opens with content, then
//! walks the rest of the history in the background. There is no Roomy → Matrix
//! backfill: Roomy's log is the source of truth on its side, and replaying it
//! into a room the bridge has only just joined would post years of history as
//! new messages.

use std::collections::HashMap;
use std::sync::Arc;

use bridge_core::{
    BackfillCursor, BridgeState, GhostDid, Input, Mapping, MatrixDeviceId, MatrixMedia, MatrixOp,
    MatrixRoomId, MissingFeature, Portal, PortalEncryption, PortalId, RoomyRoomId, SortIdx,
    SpaceDid, Step,
};
use matrix_adapter::{GhostRegistry, HomeserverClient, MatrixSendError, MatrixSender, MediaStore};
use parking_lot::Mutex;
use roomy_client::SyncSubscription;
use roomy_events::Event;
use tokio::sync::mpsc;

use crate::db::BridgeDb;

/// What a supervisor needs to run.
pub struct SupervisorDeps {
    pub db: Arc<Mutex<BridgeDb>>,
    pub homeserver: Arc<HomeserverClient>,
    pub sender: Arc<dyn MatrixSender>,
    /// The recent window a new portal reads synchronously.
    pub backfill_limit: u32,
    /// The deepest hierarchy level bridged before flattening.
    pub max_depth: u32,
    pub ghosts: Arc<Mutex<GhostRegistry>>,
    /// Moves Roomy attachments to the homeserver as `mxc://` media.
    pub media: MediaStore,
    pub roomy_events: mpsc::UnboundedSender<(roomy_events::Did, Vec<Event>)>,
    /// The state machine's memory, shared with the inbound relay so both
    /// directions read one id map.
    pub state: Arc<Mutex<BridgeState>>,
    /// What this process can do about encrypted rooms.
    pub encryption: EncryptionSupport,
}

/// What this process can do about encrypted rooms.
///
/// The supervisor turns a stored `encrypted` flag into a [`PortalEncryption`]
/// using this, so a portal can only be described as encryptable while a device
/// that can encrypt actually exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptionSupport {
    /// No crypto device is running; the named feature is what encryption needs.
    Unavailable(MissingFeature),
    /// The bridge device that encrypts outbound messages.
    Ready(MatrixDeviceId),
}

impl EncryptionSupport {
    /// How a stored encrypted flag is presented to the rest of the bridge.
    pub fn portal_encryption(&self, encrypted_room: bool) -> PortalEncryption {
        if !encrypted_room {
            return PortalEncryption::plain();
        }
        match self {
            EncryptionSupport::Ready(device) => PortalEncryption::encrypted_with(device.clone()),
            EncryptionSupport::Unavailable(missing) => {
                PortalEncryption::encrypted_unusable(*missing)
            }
        }
    }
}

/// What the supervisor needs to keep one space in sync.
///
/// Keyed by Matrix room id: an inbound event names a Matrix room, and resolving
/// it is the first thing every inbound path does.
pub struct SpaceSync {
    /// Every portal of the space, by its own identity.
    pub portals: HashMap<PortalId, Portal>,
    /// Matrix room id → portal, for inbound routing.
    pub by_matrix_room: HashMap<MatrixRoomId, PortalId>,
    /// Roomy room id → every portal that mirrors it. A Roomy room may be
    /// bridged into more than one Matrix room, so outbound events fan out;
    /// keeping one portal per Roomy room would silently drop the others.
    pub by_roomy_room: HashMap<RoomyRoomId, Vec<PortalId>>,
}

/// A backfill request for one portal.
#[derive(Debug, Clone)]
pub struct BackfillRequest {
    pub portal: PortalId,
    pub roomy_room_id: RoomyRoomId,
    /// Whether the room is encrypted and whether this process can read it.
    pub encryption: PortalEncryption,
}

/// Runs the outbound sync and the backfill queue.
pub struct Supervisor {
    db: Arc<Mutex<BridgeDb>>,
    homeserver: Arc<HomeserverClient>,
    sender: Arc<dyn MatrixSender>,
    spaces: Arc<Mutex<HashMap<SpaceDid, SpaceSync>>>,
    backfill_queue: mpsc::UnboundedSender<BackfillRequest>,
    /// How many recent messages a portal backfills before going live.
    backfill_limit: u32,
    /// The deepest hierarchy level bridged before flattening.
    max_depth: u32,
    /// Ghost identities, so an outbound message sends as the right MXID.
    ghosts: Arc<Mutex<GhostRegistry>>,
    /// Moves Roomy attachments to the homeserver as `mxc://` media.
    media: MediaStore,
    /// Where backfilled and relayed Roomy events go.
    roomy_events: mpsc::UnboundedSender<(roomy_events::Did, Vec<Event>)>,
    /// The state machine's memory: id map and edit ordering, so a backfilled
    /// event resolves edits and replies that follow it.
    state: Arc<Mutex<BridgeState>>,
    /// What this process can do about encrypted rooms.
    encryption: EncryptionSupport,
}

impl Supervisor {
    /// A supervisor over `deps`, paired with the channel that carries
    /// backfill requests into it.
    pub fn new(deps: SupervisorDeps) -> (Self, mpsc::UnboundedReceiver<BackfillRequest>) {
        let SupervisorDeps {
            db,
            homeserver,
            sender,
            backfill_limit,
            max_depth,
            ghosts,
            media,
            roomy_events,
            state,
            encryption,
        } = deps;
        let (sender_tx, receiver) = mpsc::unbounded_channel();
        (
            Self {
                db,
                homeserver,
                sender,
                spaces: Arc::new(Mutex::new(HashMap::new())),
                backfill_queue: sender_tx,
                backfill_limit,
                max_depth,
                ghosts,
                media,
                roomy_events,
                state,
                encryption,
            },
            receiver,
        )
    }

    /// Rebuild the in-memory view of a space from its portals.
    pub fn load_space(&self, space_did: &SpaceDid) -> Vec<Portal> {
        let rows = match self.db.lock().portals_for_space(space_did.as_str()) {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(%error, %space_did, "could not read portals");
                return Vec::new();
            }
        };

        let mut portals = Vec::with_capacity(rows.len());
        let mut by_id = HashMap::with_capacity(rows.len());
        let mut by_matrix_room = HashMap::with_capacity(rows.len());
        let mut by_roomy_room: HashMap<RoomyRoomId, Vec<PortalId>> = HashMap::new();
        for row in &rows {
            if let Some(portal) = portal_from_row(row, &self.encryption) {
                by_matrix_room.insert(portal.matrix_room_id().clone(), portal.id.clone());
                by_roomy_room
                    .entry(portal.roomy_room_id.clone())
                    .or_default()
                    .push(portal.id.clone());
                by_id.insert(portal.id.clone(), portal.clone());
                portals.push(portal);
            }
        }

        self.spaces.lock().insert(
            space_did.clone(),
            SpaceSync {
                portals: by_id,
                by_matrix_room,
                by_roomy_room,
            },
        );
        portals
    }

    /// The space and portal a Matrix room belongs to.
    pub fn portal_for_matrix_room(
        &self,
        matrix_room_id: &MatrixRoomId,
    ) -> Option<(SpaceDid, Portal)> {
        let spaces = self.spaces.lock();
        spaces.iter().find_map(|(space_did, space)| {
            let portal_id = space.by_matrix_room.get(matrix_room_id)?;
            space
                .portals
                .get(portal_id)
                .map(|portal| (space_did.clone(), portal.clone()))
        })
    }

    /// The spaces this supervisor currently knows about.
    pub fn known_spaces(&self) -> Vec<SpaceDid> {
        self.spaces.lock().keys().cloned().collect()
    }

    /// The highest stream index persisted for a space, used to resume a socket.
    pub fn cursor_for(&self, space_did: &SpaceDid) -> SortIdx {
        let roomy_rooms: Vec<RoomyRoomId> = self
            .spaces
            .lock()
            .get(space_did)
            .map(|space| {
                space
                    .portals
                    .values()
                    .map(|portal| portal.roomy_room_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        let db = self.db.lock();
        let highest = roomy_rooms
            .iter()
            .filter_map(|room| db.cursor(space_did.as_str(), room.as_str()).ok().flatten())
            .max()
            .unwrap_or(0);
        SortIdx::new(highest).unwrap_or(SortIdx::new(0).expect("zero is a valid position"))
    }

    /// Enqueue events for the writer task.
    pub fn enqueue_events(&self, space_did: roomy_events::Did, events: Vec<Event>) {
        if events.is_empty() {
            return;
        }
        if let Err(error) = self.roomy_events.send((space_did, events)) {
            tracing::error!(%error, "writer channel closed; dropping events");
        }
    }

    /// Queue a portal's background backfill.
    pub fn enqueue_backfill(&self, request: BackfillRequest) {
        if let Err(error) = self.backfill_queue.send(request) {
            tracing::warn!(%error, "backfill queue closed");
        }
    }

    /// One outbound pass: read a batch from the socket and send it to Matrix.
    ///
    /// Returns how many events were relayed, so the caller can tell an idle
    /// connection (all echoes) from a busy one.
    pub async fn pump_outbound(
        &self,
        space_did: &SpaceDid,
        subscription: &mut SyncSubscription,
    ) -> Result<usize, OutboundError> {
        let events = match subscription.next_batch().await {
            Some(Ok(events)) => events,
            Some(Err(error)) => return Err(OutboundError::Socket(error.to_string())),
            None => return Err(OutboundError::Closed),
        };

        let mut relayed = 0;
        for sync_event in &events {
            let event = match sync_event.event() {
                Ok(event) => event,
                // An event this crate does not model cannot be relayed, but it
                // does move the cursor, so it is skipped rather than retried.
                Err(_) => continue,
            };
            if self.relay_outbound(space_did, &event).await? {
                relayed += 1;
            }
        }

        self.advance_cursors(space_did, &events);
        Ok(relayed)
    }

    /// Relay one Roomy event to Matrix, if it is not an echo.
    ///
    /// A Roomy room may be mirrored by more than one Matrix room, so the event
    /// is relayed to every portal that maps it. Returns whether any portal
    /// accepted it.
    async fn relay_outbound(
        &self,
        space_did: &SpaceDid,
        event: &Event,
    ) -> Result<bool, OutboundError> {
        let roomy_room_id = match &event.room {
            Some(room) => match RoomyRoomId::parse(room.as_str().to_string()) {
                Ok(room) => room,
                // An event naming something that is not a room id is not a
                // message this bridge can address.
                Err(_) => return Ok(false),
            },
            // A space-level event is not a message and has no Matrix
            // counterpart.
            None => return Ok(false),
        };

        let portals = {
            let spaces = self.spaces.lock();
            spaces
                .get(space_did)
                .map(|space| {
                    space
                        .by_roomy_room
                        .get(&roomy_room_id)
                        .map(|ids| {
                            ids.iter()
                                .filter_map(|id| space.portals.get(id).cloned())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .unwrap_or_default()
        };

        let mut relayed = false;
        for portal in &portals {
            if self.relay_to_portal(event, portal).await? {
                relayed = true;
            }
        }
        Ok(relayed)
    }

    /// Relay one Roomy event to one portal's Matrix room.
    async fn relay_to_portal(&self, event: &Event, portal: &Portal) -> Result<bool, OutboundError> {
        if !portal.state.is_live() {
            return Ok(false);
        }
        // A portal starts at its own creation. Replaying the space's history
        // into a room the bridge has only just joined would post old messages
        // as new ones, and a replayed reply names an event the room has never
        // seen. The event id is a ULID, so it carries the time it was written.
        if (event.id.timestamp_ms() as i64) < portal.created_at {
            return Ok(false);
        }
        // An encrypted room the bridge cannot encrypt for gets no plaintext.
        // The admin path marks such a portal blocked, and this is the other
        // half of that guarantee: even if the state says syncing, the send is
        // refused rather than downgrading to `m.room.message`.
        if let Some(missing) = portal.encryption.missing() {
            tracing::warn!(
                room = %portal.matrix_room_id(),
                missing = missing.label(),
                "refusing to send into an encrypted room without a usable device"
            );
            return Ok(false);
        }

        let Some(mut op) = self.matrix_op_for(event, portal) else {
            return Ok(false);
        };

        // Uploading is async, so the pure translation leaves the media slot
        // empty; it is filled here before the content is built from it.
        if let MatrixOp::Send { media, .. } = &mut op {
            *media = self.resolve_media(event).await;
        }
        let media = match &op {
            MatrixOp::Send { media, .. } => media.as_slice(),
            _ => &[],
        };
        let Some(content) = crate::outbound::content_for(&op, media) else {
            return Ok(false);
        };
        let sender = crate::outbound::sender_of(&op);
        let matrix_event_id = match self
            .sender
            .send_content(
                crate::outbound::room_of(&op)
                    .map(|room| room.as_str())
                    .unwrap_or_else(|| portal.matrix_room_id().as_str()),
                sender,
                content,
            )
            .await
        {
            Ok(event_id) => event_id,
            // An event the homeserver refuses (a redaction of something it does
            // not have, a malformed relation) is refused on every attempt. The
            // stream cursor may only advance past a batch, so propagating would
            // wedge the space on one poison event and replay it forever.
            Err(error) if error.is_permanent() => {
                tracing::warn!(
                    %error,
                    room = %portal.matrix_room_id(),
                    event = %event.id,
                    "the homeserver refused an outbound event; skipping it"
                );
                return Ok(false);
            }
            Err(error) => return Err(OutboundError::Send(error.to_string())),
        };

        // Every send is recorded, not only reactions. The Matrix event the
        // bridge wrote comes back through `/transactions`, and the id map is
        // what makes it recognisable as the bridge's own; for a reaction it is
        // also what lets a removal redact the right Matrix event. The Matrix id
        // only exists now that the homeserver has answered, which is why this
        // pairing is recorded here rather than decided by `step`.
        if let Some(mapping) = op.pairing(event.id.as_str(), matrix_event_id, crate::now_ms()) {
            self.record_mapping(portal.space(), &mapping);
        }

        Ok(true)
    }

    /// Record an id pairing in memory and in the database, so echo suppression
    /// and edit/redaction resolution both survive a restart.
    fn record_mapping(&self, space_did: &SpaceDid, mapping: &Mapping) {
        self.state.lock().record_mapping(mapping.clone());
        self.persist_mapping(space_did, mapping);
    }

    /// Persist a pairing the machine already holds in memory.
    fn persist_mapping(&self, space_did: &SpaceDid, mapping: &Mapping) {
        if let Err(error) = self.db.lock().put_mapping(space_did.as_str(), mapping) {
            tracing::warn!(%error, "could not persist an id mapping");
        }
    }

    /// Translate a Roomy event into a Matrix op, or `None` when it is an echo
    /// or not something Matrix represents.
    fn matrix_op_for(&self, event: &Event, portal: &Portal) -> Option<MatrixOp> {
        // Mint the ghost for this author first: `to_matrix_op` resolves the
        // sender through the registry, so an author with no ghost yet yields no
        // op and their first message would be silently dropped.
        if let Some(author) = author_of(event) {
            if let Ok(author) = roomy_events::Did::parse(author.to_string()) {
                self.ensure_ghost(&author);
            }
        }
        crate::outbound::to_matrix_op(
            event,
            portal,
            &self.ghosts.lock(),
            &self.state.lock(),
            self.max_depth,
        )
    }

    /// Fetch a Roomy message's attachments from the appserver and upload them
    /// to the homeserver, so the resulting op can name them as `mxc://` media.
    ///
    /// A single attachment that cannot be moved is logged and skipped: the
    /// message still reaches Matrix with its text rather than being lost.
    async fn resolve_media(&self, event: &Event) -> Vec<MatrixMedia> {
        let references = crate::outbound::attachment_refs(event);
        let mut media = Vec::with_capacity(references.len());
        for reference in references {
            let bytes = match self.media.download_blob(&reference.uri).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(
                        %error,
                        uri = %reference.uri,
                        "could not fetch a Roomy attachment"
                    );
                    continue;
                }
            };
            match self.media.upload_to_matrix(&bytes).await {
                Ok(mxc_uri) => media.push(MatrixMedia {
                    mxc_uri: mxc_uri.as_str().to_string(),
                    mime_type: if reference.mime_type.is_empty() {
                        bytes.mime_type
                    } else {
                        reference.mime_type
                    },
                    name: reference.name,
                    size: Some(bytes.data.len() as u64),
                }),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        uri = %reference.uri,
                        "could not upload a Roomy attachment"
                    );
                }
            }
        }
        media
    }

    /// Make sure a Roomy author has a Matrix ghost, persisting the mapping.
    fn ensure_ghost(&self, did: &roomy_events::Did) {
        let mxid = {
            let mut ghosts = self.ghosts.lock();
            if ghosts.mxid_of(did).is_some() {
                return;
            }
            // A ghost the database remembers is the one whose history the room
            // already carries; adopt it rather than minting a second identity.
            if let Ok(Some(stored)) = self.db.lock().ghost_for_did(did.as_str()) {
                if let Ok(ghost_mxid) = bridge_core::GhostMxid::parse(stored.mxid.clone()) {
                    if ghosts.did_for(&ghost_mxid) == Some(did) {
                        return;
                    }
                }
            }
            match ghosts.register(did, None, None) {
                Ok(ghost) => ghost.mxid,
                Err(error) => {
                    tracing::warn!(%error, %did, "could not mint a ghost");
                    return;
                }
            }
        };

        // The ghost's MXID must survive a restart: it is the identity every
        // message the author has already sent was attributed to, and a new one
        // would split their history across two Matrix users.
        if let Err(error) = self.db.lock().put_ghost(&crate::db::GhostWrite {
            mxid: mxid.as_str(),
            did: did.as_str(),
            profile_hash: None,
            updated_at: crate::now_ms(),
        }) {
            tracing::warn!(%error, %did, "could not persist a ghost");
        }
    }

    /// Persist the highest stream index a batch carried.
    fn advance_cursors(&self, space_did: &SpaceDid, events: &[roomy_client::SyncEvent]) {
        let Some(highest) = events.iter().map(|event| event.idx).max() else {
            return;
        };
        let Ok(highest) = SortIdx::new(highest) else {
            tracing::warn!(position = highest, "ignoring a negative stream position");
            return;
        };
        let db = self.db.lock();
        for portal in self
            .spaces
            .lock()
            .get(space_did)
            .map(|space| space.portals.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
        {
            if let Err(error) = db.set_cursor(
                space_did.as_str(),
                portal.roomy_room_id.as_str(),
                highest.value(),
            ) {
                tracing::warn!(%error, "could not persist a cursor");
            }
        }
    }

    /// Run one backfill step for a portal.
    ///
    /// `phase` is `recent` for the synchronous window and `deep` for the
    /// background walk. A deep walk that hits an encrypted room stops rather
    /// than spending the history budget on events it cannot read.
    pub async fn step_backfill(
        &self,
        request: &BackfillRequest,
    ) -> Result<BackfillStep, OutboundError> {
        let previous = self
            .db
            .lock()
            .backfill(
                request.portal.space().as_str(),
                request.portal.matrix_room().as_str(),
            )
            .map_err(|error| OutboundError::Storage(error.to_string()))?;

        // A completed portal has nothing left to walk; reporting `complete` is
        // what the admin API shows rather than pretending there is work.
        if previous.as_ref().is_some_and(|row| row.complete) {
            return Ok(BackfillStep {
                phase: previous
                    .as_ref()
                    .map(|row| row.phase.clone())
                    .unwrap_or_else(|| "deep".to_string()),
                complete: true,
                messages: previous
                    .as_ref()
                    .map(|row| row.messages as u64)
                    .unwrap_or(0),
                relayed: 0,
            });
        }
        let phase = match &previous {
            Some(row) => row.phase.clone(),
            None => "recent".to_string(),
        };

        // An encrypted room's history is unreadable without the room key, so a
        // backfill of one stops immediately and says so rather than walking
        // megabytes of ciphertext it cannot use.
        if request.encryption.is_encrypted() {
            self.db
                .lock()
                .set_backfill(&crate::db::BackfillWrite {
                    space_did: request.portal.space().as_str(),
                    matrix_room_id: request.portal.matrix_room().as_str(),
                    phase: "skipped",
                    token: None,
                    messages: 0,
                    complete: true,
                    updated_at: crate::now_ms(),
                })
                .map_err(|error| OutboundError::Storage(error.to_string()))?;
            return Ok(BackfillStep {
                phase: "skipped".to_string(),
                complete: true,
                messages: 0,
                relayed: 0,
            });
        }

        let _ = &request.roomy_room_id;
        let token = previous
            .as_ref()
            .and_then(|row| row.token.as_deref())
            .and_then(|token| BackfillCursor::parse(token).ok());
        let (events, next_token) = self
            .homeserver
            .backfill(
                request.portal.matrix_room().as_str(),
                token.as_ref(),
                self.backfill_limit.min(100),
            )
            .await
            .map_err(|error| OutboundError::Homeserver(error.to_string()))?;

        let messages = previous
            .as_ref()
            .map(|row| row.messages as u64)
            .unwrap_or(0)
            + events.len() as u64;

        // A recent window of `backfill_limit` messages, then the socket takes
        // over and the deep walk continues in the background.
        let complete = next_token.is_none() || messages >= self.backfill_limit as u64;
        // The recent window is read once; everything after it is the deep
        // walk, so the recorded phase is always `deep` once a page has landed.
        let next_phase = "deep";

        self.db
            .lock()
            .set_backfill(&crate::db::BackfillWrite {
                space_did: request.portal.space().as_str(),
                matrix_room_id: request.portal.matrix_room().as_str(),
                phase: next_phase,
                token: next_token.as_ref().map(BackfillCursor::as_str),
                messages,
                complete,
                updated_at: crate::now_ms(),
            })
            .map_err(|error| OutboundError::Storage(error.to_string()))?;

        // Translate and enqueue the page. A backfilled message carries its
        // Matrix `origin_server_ts` as `timestampOverride`, which the appserver
        // folds into `sort_idx`, so history lands chronologically rather than
        // at the tip.
        let relayed = self.relay_backfill(request, &events);
        Ok(BackfillStep {
            phase,
            complete,
            messages,
            relayed,
        })
    }

    /// Turn raw Matrix PDUs into Roomy events and enqueue them.
    fn relay_backfill(&self, request: &BackfillRequest, events: &[serde_json::Value]) -> usize {
        let Some((space_did, portal)) = self.portal_for_matrix_room(request.portal.matrix_room())
        else {
            return 0;
        };
        let Ok(space_did_parsed) = space_did.to_did() else {
            return 0;
        };

        // The transaction translator is the one place a PDU becomes an
        // `IncomingEvent`; reusing it keeps backfilled and live messages
        // identical in shape.
        let transaction: matrix_adapter::transaction::Transaction =
            match serde_json::from_value(serde_json::json!({ "events": events })) {
                Ok(transaction) => transaction,
                Err(error) => {
                    tracing::warn!(%error, "could not read a backfill page");
                    return 0;
                }
            };
        let handler = matrix_adapter::transaction::TransactionHandler::new();
        let incoming = handler.incoming(&transaction);

        let mut built = Vec::with_capacity(incoming.len());
        for incoming_event in incoming {
            let ghost = GhostDid::from(&incoming_event.sender);
            let step = {
                let mut state = self.state.lock();
                bridge_core::step(
                    &mut state,
                    Input::Matrix {
                        event: &incoming_event,
                        portal: &portal,
                        ghost: &ghost,
                    },
                    crate::now_ms(),
                )
            };
            let Step::Accepted(writes) = step else {
                continue;
            };
            for write in writes {
                let Some(roomy_event) =
                    crate::relay::build_event(write.id(), &portal.roomy_room_id, write.op())
                else {
                    continue;
                };
                self.persist_mapping(&space_did, write.mapping());
                built.push(roomy_event);
            }
        }

        let count = built.len();
        self.enqueue_events(space_did_parsed, built);
        count
    }
}

/// The result of one backfill step.
#[derive(Debug, Clone)]
pub struct BackfillStep {
    pub phase: String,
    /// Whether the portal's history has been walked to its start.
    pub complete: bool,
    /// Messages the portal has backfilled in total.
    pub messages: u64,
    /// Messages this step wrote into Roomy.
    pub relayed: usize,
}

/// The Roomy author an event is attributed to, if it has one.
fn author_of(event: &Event) -> Option<&str> {
    match &event.kind {
        roomy_events::EventKind::CreateMessage(message) => message
            .extensions
            .author_override
            .as_ref()
            .map(|author| author.did.as_str()),
        roomy_events::EventKind::AddBridgedReaction(reaction) => {
            Some(reaction.reacting_user.as_str())
        }
        roomy_events::EventKind::RemoveBridgedReaction(reaction) => {
            Some(reaction.reacting_user.as_str())
        }
        _ => None,
    }
}

/// Build a portal from its stored row.
///
/// The stored `encrypted` flag plus this process's [`EncryptionSupport`] decide
/// whether the portal is plain, encryptable, or encrypted-but-unusable; a row
/// alone cannot claim the bridge can encrypt.
pub fn portal_from_row(
    row: &crate::db::PortalRow,
    encryption: &EncryptionSupport,
) -> Option<Portal> {
    Some(Portal {
        id: PortalId::new(
            SpaceDid::parse(row.space_did.clone()).ok()?,
            MatrixRoomId::parse(row.matrix_room_id.clone()).ok()?,
        ),
        roomy_room_id: RoomyRoomId::parse(row.roomy_room_id.clone()).ok()?,
        depth: row.depth,
        name: row.name.clone(),
        encryption: encryption.portal_encryption(row.encrypted),
        state: portal_state(row),
        created_at: row.created_at,
    })
}

/// The portal state a stored row names.
pub fn portal_state(row: &crate::db::PortalRow) -> bridge_core::PortalState {
    match row.state.as_str() {
        "backfilling" => bridge_core::PortalState::Backfilling { messages: 0 },
        "paused" => bridge_core::PortalState::Paused {
            reason: row.reason.clone().unwrap_or_default(),
        },
        "blocked" => bridge_core::PortalState::Blocked {
            reason: row.reason.clone().unwrap_or_default(),
        },
        _ => bridge_core::PortalState::Syncing,
    }
}

/// The outbound loop failed.
#[derive(Debug, Clone, thiserror::Error)]
pub enum OutboundError {
    #[error("the sync socket closed")]
    Closed,
    #[error("sync socket error: {0}")]
    Socket(String),
    #[error("could not send to Matrix: {0}")]
    Send(String),
    #[error("homeserver error: {0}")]
    Homeserver(String),
    #[error("storage error: {0}")]
    Storage(String),
}

impl From<MatrixSendError> for OutboundError {
    fn from(error: MatrixSendError) -> Self {
        OutboundError::Send(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;

    use matrix_adapter::OutgoingContent;
    use roomy_events::extensions::ExtensionBag;

    const ROOM: &str = "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB";
    const MESSAGE: &str = "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF";
    const REACTION: &str = "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0GH";
    const REMOVAL: &str = "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0JK";
    const IMAGE: &str = "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0KM";

    #[derive(Default)]
    struct RecordingSender {
        sent: Mutex<Vec<(String, Option<String>, OutgoingContent)>>,
    }

    impl MatrixSender for RecordingSender {
        fn send_content<'a>(
            &'a self,
            room_id: &'a str,
            sender_mxid: Option<&'a str>,
            content: OutgoingContent,
        ) -> Pin<Box<dyn Future<Output = Result<String, MatrixSendError>> + Send + 'a>> {
            Box::pin(async move {
                self.sent.lock().push((
                    room_id.to_string(),
                    sender_mxid.map(str::to_string),
                    content,
                ));
                Ok("$reaction-event".to_string())
            })
        }
    }

    fn ulid(value: &str) -> roomy_events::Ulid {
        roomy_events::Ulid::parse(value).unwrap()
    }

    fn reacting_user() -> roomy_events::Did {
        roomy_events::Did::parse("did:plc:alice").unwrap()
    }

    fn space_did() -> SpaceDid {
        SpaceDid::parse("did:plc:space").unwrap()
    }

    fn supervisor(
        sender: Arc<RecordingSender>,
        media: MediaStore,
    ) -> (Supervisor, Arc<Mutex<BridgeState>>) {
        supervisor_created_at(sender, media, 0)
    }

    fn supervisor_created_at(
        sender: Arc<RecordingSender>,
        media: MediaStore,
        created_at: i64,
    ) -> (Supervisor, Arc<Mutex<BridgeState>>) {
        let db = Arc::new(Mutex::new(BridgeDb::open_in_memory().unwrap()));
        let matrix_room_id = bridge_core::MatrixRoomId::parse("!room:example.org").unwrap();
        let roomy_room_id = bridge_core::RoomyRoomId::parse(ROOM).unwrap();
        db.lock()
            .insert_bridge(&crate::db::BridgeConfigRow {
                id: "bridge".into(),
                space_did: space_did().as_str().into(),
                matrix_id: matrix_room_id.as_str().into(),
                kind: "room".into(),
                mode: "full".into(),
                auto_bridge: false,
                target_room_id: None,
                created_at: 0,
                updated_at: 0,
            })
            .unwrap();
        db.lock()
            .upsert_portal(&crate::db::portal_row(crate::db::NewPortal {
                space_did: space_did().as_str(),
                bridge_id: "bridge",
                matrix_room_id: &matrix_room_id,
                roomy_room_id: &roomy_room_id,
                depth: 0,
                name: None,
                encrypted: false,
                now: created_at,
            }))
            .unwrap();

        let (writer, _queue) = mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(BridgeState::new()));
        // The message the reaction annotates is bridged.
        state.lock().record_mapping(Mapping {
            kind: bridge_core::MappingKind::Message,
            matrix_id: "$matrix-msg".into(),
            roomy_id: MESSAGE.into(),
            created_at: 0,
        });

        let (supervisor, _backfill) = Supervisor::new(SupervisorDeps {
            db,
            homeserver: Arc::new(HomeserverClient::new(
                "http://127.0.0.1:1",
                matrix_adapter::AsToken::parse("token").unwrap(),
            )),
            sender,
            backfill_limit: 50,
            max_depth: 2,
            ghosts: Arc::new(Mutex::new(GhostRegistry::new("matrix.test"))),
            media,
            roomy_events: writer,
            state: state.clone(),
            encryption: EncryptionSupport::Unavailable(MissingFeature::CryptoDevice),
        });
        supervisor.load_space(&space_did());
        (supervisor, state)
    }

    fn reaction_event(id: &str, kind: roomy_events::EventKind) -> Event {
        Event::in_room(ulid(id), ulid(ROOM), kind)
    }

    #[tokio::test]
    async fn an_event_written_before_the_portal_is_not_relayed() {
        // Bridging a room must not replay the space's history into it: the
        // events predate the portal, and a replayed reply names an event the
        // room has never seen.
        let sender = Arc::new(RecordingSender::default());
        let (supervisor, _state) = supervisor_created_at(
            sender.clone(),
            MediaStore::new(
                "http://127.0.0.1:1",
                matrix_adapter::AsToken::parse("token").unwrap(),
                "http://127.0.0.1:1",
            ),
            2_000_000_000_000,
        );
        let event = Event::in_room(
            ulid(IMAGE),
            ulid(ROOM),
            roomy_events::EventKind::CreateMessage(roomy_events::CreateMessage {
                body: roomy_events::Content::markdown("old news"),
                extensions: roomy_events::MessageExtensions {
                    author_override: Some(roomy_events::extensions::AuthorOverride {
                        did: roomy_events::Did::parse("did:plc:alice").unwrap(),
                    }),
                    ..Default::default()
                },
            }),
        );
        assert!(!supervisor
            .relay_outbound(&space_did(), &event)
            .await
            .unwrap());
        assert!(sender.sent.lock().is_empty());
    }

    #[tokio::test]
    async fn a_relayed_reaction_is_recorded_so_its_removal_redacts_it() {
        let sender = Arc::new(RecordingSender::default());
        let (supervisor, state) = supervisor(
            sender.clone(),
            MediaStore::new(
                "http://127.0.0.1:1",
                matrix_adapter::AsToken::parse("token").unwrap(),
                "http://127.0.0.1:1",
            ),
        );

        let add = reaction_event(
            REACTION,
            roomy_events::EventKind::AddBridgedReaction(roomy_events::AddBridgedReaction {
                reaction_to: ulid(MESSAGE),
                reaction: "🎉".into(),
                reacting_user: reacting_user(),
                extensions: ExtensionBag::new(),
            }),
        );
        assert!(supervisor.relay_outbound(&space_did(), &add).await.unwrap());
        assert_eq!(
            state
                .lock()
                .matrix_id(bridge_core::MappingKind::Reaction, REACTION),
            Some("$reaction-event"),
            "the sent reaction is mapped by the Roomy event id a removal names"
        );

        let remove = reaction_event(
            REMOVAL,
            roomy_events::EventKind::RemoveBridgedReaction(roomy_events::RemoveBridgedReaction {
                reaction_id: ulid(REACTION),
                reacting_user: reacting_user(),
                extensions: ExtensionBag::new(),
            }),
        );
        assert!(supervisor
            .relay_outbound(&space_did(), &remove)
            .await
            .unwrap());

        let sent = sender.sent.lock();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].2.event_type, "m.reaction");
        assert!(
            sent[0]
                .1
                .as_deref()
                .is_some_and(|mxid| mxid.starts_with("@_roomy_")),
            "the reaction is sent as the reacting ghost"
        );
        assert_eq!(sent[1].2.event_type, "m.room.redaction");
        assert_eq!(sent[1].2.content["redacts"], "$reaction-event");
    }

    #[tokio::test]
    async fn a_roomy_image_attachment_is_uploaded_and_sent_as_an_m_image() {
        use axum::response::IntoResponse;

        use roomy_events::extensions::{AttachmentsExtension, AuthorOverride, ImageAttachment};

        // One throwaway server: the appserver's blob proxy and the
        // homeserver's media upload live behind the same base URL.
        let blob = axum::routing::get(|| async {
            (
                [(axum::http::header::CONTENT_TYPE, "image/png")],
                [0x89u8, b'P', b'N', b'G'],
            )
                .into_response()
        });
        let upload = axum::routing::post(|| async {
            axum::Json(serde_json::json!({
                "content_uri": "mxc://stub.example/uploaded"
            }))
        });
        let app = axum::Router::new()
            .route("/blob/{did}/{cid}", blob)
            .route("/_matrix/media/v3/upload", upload);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port is free");
        let base = format!("http://{}", listener.local_addr().expect("bound"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let sender = Arc::new(RecordingSender::default());
        let (supervisor, _state) = supervisor(
            sender.clone(),
            MediaStore::new(
                &base,
                matrix_adapter::AsToken::parse("as-token").unwrap(),
                &base,
            ),
        );

        let event = Event::in_room(
            ulid(IMAGE),
            ulid(ROOM),
            roomy_events::EventKind::CreateMessage(roomy_events::CreateMessage {
                body: roomy_events::Content::markdown("look"),
                extensions: roomy_events::MessageExtensions {
                    author_override: Some(AuthorOverride {
                        did: roomy_events::Did::parse("did:plc:alice").unwrap(),
                    }),
                    attachments: Some(AttachmentsExtension::new(vec![ImageAttachment {
                        uri: "atblob://did:plc:alice/bafkreiphotograph".into(),
                        mime_type: "image/png".into(),
                        alt: None,
                        height: None,
                        width: None,
                        size: Some(4),
                    }
                    .into()])),
                    ..Default::default()
                },
            }),
        );

        assert!(supervisor
            .relay_outbound(&space_did(), &event)
            .await
            .unwrap());

        let sent = sender.sent.lock();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].2.event_type, "m.room.message");
        assert_eq!(sent[0].2.content["msgtype"], "m.image");
        assert_eq!(sent[0].2.content["url"], "mxc://stub.example/uploaded");
        assert_eq!(sent[0].2.content["info"]["mimetype"], "image/png");
    }
}
