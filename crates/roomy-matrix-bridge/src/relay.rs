//! The supervisor: the loop that actually moves messages.
//!
//! Three jobs, each with its own task:
//!
//! * **Inbound.** Transactions arrive on the appservice server, are translated
//!   by `bridge-core`, and are written to Roomy through the outbox.
//! * **Outbound.** A sync socket per space yields Roomy events; those the bridge
//!   did not produce are sent to Matrix as the right ghost.
//! * **Backfill.** A portal created by an admin API call gets a capped recent
//!   window synchronously and the rest in the background.
//!
//! Echo suppression is by id map and origin extension, both supplied by
//! `bridge-core`; the supervisor owns only the transport.

use std::future::Future;
use std::sync::Arc;

use bridge_core::{
    BridgeState, GhostDid, IncomingEvent, IncomingKind, Input, Mapping, RoomyEventId, RoomyRoomId,
    SpaceDid, Step,
};
use matrix_adapter::transaction::{ToDeviceMessage, Transaction};
use matrix_adapter::MediaStore;
use parking_lot::Mutex;
use roomy_client::AppserverClient;
use roomy_events::{Content, Did, Event, EventKind, MessageExtensions, Ulid};

use crate::db::BridgeDb;
use crate::server::TransactionRelay;

/// Everything the relay needs, shared with the server.
pub struct Relay {
    /// What one event needs to be translated; the inbound worker holds the same
    /// value, which is why the relay is cheap to move into the server.
    state: Arc<RelayState>,
    /// Transactions wait here until the worker takes them, so the appservice
    /// request returns without holding a media transfer open.
    transactions: tokio::sync::mpsc::UnboundedSender<Transaction>,
}

/// The state a translation needs.
struct RelayState {
    db: Arc<Mutex<BridgeDb>>,
    /// The state machine's memory, shared with the supervisor.
    state: Arc<Mutex<BridgeState>>,
    /// Portal lookup is the supervisor's, so a portal created through the admin
    /// API is visible to inbound traffic without a second cache to keep aligned.
    supervisor: Arc<crate::supervisor::Supervisor>,
    /// The bridge's own DID, so an event it wrote is recognised as its own, and
    /// the owner of every blob uploaded from Matrix.
    bridge_did: Did,
    /// The bridge's own Matrix user, whose events are housekeeping rather than
    /// conversation.
    bridge_mxid: String,
    /// Moves attachments between the homeserver and the appserver.
    media: MediaStore,
    /// The appserver the blobs are uploaded to.
    appserver: Arc<AppserverClient>,
    clock: Arc<dyn bridge_core::Clock>,
}

/// What a relay is built from.
pub struct RelayDeps {
    pub db: Arc<Mutex<BridgeDb>>,
    pub supervisor: Arc<crate::supervisor::Supervisor>,
    /// The bridge's own DID, already validated by the caller.
    pub bridge_did: Did,
    /// The bridge's own Matrix user, whose events are housekeeping rather than
    /// conversation.
    pub sender_localpart: String,
    pub domain: String,
    pub media: MediaStore,
    pub appserver: Arc<AppserverClient>,
    pub state: Arc<Mutex<BridgeState>>,
    pub clock: Arc<dyn bridge_core::Clock>,
}

impl Relay {
    /// A relay over the clients and state in `deps`.
    pub fn new(deps: RelayDeps) -> Self {
        let RelayDeps {
            db,
            supervisor,
            bridge_did,
            sender_localpart,
            domain,
            media,
            appserver,
            state,
            clock,
        } = deps;

        // Warm the dedupe index from the database: after a restart the bridge
        // must still recognise the events it wrote before it stopped.
        if let Ok(mappings) = db.lock().mappings(bridge_did.as_str()) {
            let mut bridge_state = state.lock();
            for mapping in mappings {
                bridge_state.record_mapping(mapping);
            }
        }

        let state = Arc::new(RelayState {
            db,
            state,
            supervisor,
            bridge_did,
            bridge_mxid: format!("@{sender_localpart}:{domain}"),
            media,
            appserver,
            clock,
        });

        // One worker, not one per transaction: media uploads are slow, and two
        // uploads racing would reorder messages the homeserver delivered in
        // sequence. The channel is what preserves that order across the
        // synchronous appservice handler and the awaiting worker.
        let (transactions, mut queued) = tokio::sync::mpsc::unbounded_channel();
        let worker = state.clone();
        tokio::spawn(async move {
            while let Some(transaction) = queued.recv().await {
                for event in incoming_events(&transaction) {
                    worker.relay_inbound(event).await;
                }
            }
        });

        Self {
            state,
            transactions,
        }
    }
}

/// The incoming events for a transaction, translated once.
///
/// The transaction handler owns the "have I seen this" set; the server already
/// checked the transaction id, so this only translates.
fn incoming_events(transaction: &Transaction) -> Vec<IncomingEvent> {
    let handler = matrix_adapter::transaction::TransactionHandler::new();
    handler.incoming(transaction)
}

impl RelayState {
    /// Hand events to the supervisor's writer, which owns ordering and retry.
    fn enqueue_roomy(&self, space_did: Did, events: Vec<Event>) {
        self.supervisor.enqueue_events(space_did, events);
    }

    /// Persist a pairing the machine recorded when it accepted an op, so echo
    /// suppression and edit/redaction resolution both survive a restart.
    fn persist_mapping(&self, space_did: &SpaceDid, mapping: &Mapping) {
        if let Err(error) = self.db.lock().put_mapping(space_did.as_str(), mapping) {
            tracing::warn!(%error, "could not persist an id mapping");
        }
    }
}

impl TransactionRelay for Relay {
    fn relay(&self, transaction: Transaction) {
        // The appservice handler is synchronous; the worker is where the
        // awaiting happens.
        if self.transactions.send(transaction).is_err() {
            tracing::error!("the inbound worker has stopped; dropping a transaction");
        }
    }

    fn relay_to_device(&self, messages: Vec<ToDeviceMessage>) {
        // The machine ingests room keys in the server, which owns the async
        // boundary; the relay only sees what is left to translate.
        for message in messages {
            tracing::debug!(
                sender = %message.sender,
                kind = %message.kind,
                "to-device message received"
            );
        }
    }

    /// Relay a transaction whose encrypted events are decrypted first.
    #[cfg(feature = "e2ee")]
    fn relay_decrypted<'a>(
        &'a self,
        transaction: Transaction,
        crypto: &'a matrix_adapter::CryptoMachine,
    ) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let handler = matrix_adapter::transaction::TransactionHandler::new();
            for event in handler.incoming_decrypted(&transaction, crypto).await {
                self.state.relay_inbound(event).await;
            }
        })
    }
}

impl RelayState {
    /// Move every `mxc://` attachment of an event into the appserver, rewriting
    /// the event to name the resulting `atblob://` references.
    ///
    /// A transfer that fails leaves the `mxc://` URI in place: the attachment
    /// is then dropped by `build_event`, but the message text still arrives.
    async fn host_media(&self, event: &mut IncomingEvent) {
        host_attachments(&self.media, &self.appserver, &self.bridge_did, event).await;
    }

    /// Relay one Matrix event into Roomy.
    async fn relay_inbound(&self, mut event: IncomingEvent) {
        // The bridge's own appservice user never sends into a room except to
        // join a ghost; relaying its messages would attribute them to a DID
        // that is not a person. Ghosts carry their own MXIDs and still pass.
        if event.sender.as_str() == self.bridge_mxid {
            return;
        }

        let Some((space_did, portal)) = self.supervisor.portal_for_matrix_room(&event.room_id)
        else {
            tracing::debug!(room = %event.room_id, "no portal for this room; dropping");
            return;
        };
        if !portal.state.is_live() {
            tracing::debug!(room = %event.room_id, "portal is not live; dropping");
            return;
        }

        self.host_media(&mut event).await;

        let ghost = GhostDid::from(&event.sender);
        let now = self.clock.now_ms();
        let outcome = {
            let mut state = self.state.lock();
            bridge_core::step(
                &mut state,
                Input::Matrix {
                    event: &event,
                    portal: &portal,
                    ghost: &ghost,
                },
                now,
            )
        };
        let Step::Accepted(writes) = outcome else {
            if let Step::Rejected(reason) = outcome {
                tracing::debug!(
                    event = %event.event_id,
                    reason = reason.label(),
                    "not relaying an inbound event"
                );
            }
            return;
        };

        // Named at debug level, with the op count: a bridge that relays nothing
        // is either rejecting events (logged above) or never receiving them,
        // and this line is what tells the two apart from the outside.
        tracing::debug!(
            event = %event.event_id,
            room = %event.room_id,
            sender = %event.sender,
            ops = writes.len(),
            "relaying an inbound event"
        );

        let space_did_parsed = match space_did.to_did() {
            Ok(did) => did,
            Err(_) => return,
        };

        for write in writes {
            let built = build_event(write.id(), &portal.roomy_room_id, write.op());
            let Some(built) = built else { continue };

            // The machine recorded the pairing when it accepted the op, and
            // recorded it before this enqueue rather than after the appserver
            // confirms: a confirmation arrives after the homeserver may already
            // have re-delivered the same event. Persisting it is what makes the
            // suppression survive a restart.
            self.persist_mapping(&space_did, write.mapping());

            self.enqueue_roomy(space_did_parsed.clone(), vec![built]);
        }
    }
}

/// Move an event's `mxc://` attachments onto the appserver as `atblob://`
/// references owned by `owner`.
///
/// Each attachment is downloaded from the homeserver and re-uploaded as the
/// bridge account's blob; the event names the new reference. A failed transfer
/// leaves the original `mxc://` URI, which `build_event` drops — the text still
/// reaches Roomy, which is what a reader needs when the media is unavailable.
async fn host_attachments(
    media_store: &MediaStore,
    appserver: &AppserverClient,
    owner: &Did,
    event: &mut IncomingEvent,
) {
    let IncomingKind::Message { media, .. } = &mut event.kind else {
        return;
    };
    for attachment in media {
        if !attachment.mxc_uri.starts_with("mxc://") {
            continue;
        }
        let uploaded = async {
            let uri = matrix_adapter::MxcUri::parse(attachment.mxc_uri.clone())
                .map_err(|error| error.to_string())?;
            let bytes = media_store
                .download_mxc(&uri)
                .await
                .map_err(|error| error.to_string())?;
            appserver
                .upload_blob(owner, bytes.data, &bytes.mime_type)
                .await
                .map_err(|error| error.to_string())
        }
        .await;
        match uploaded {
            Ok(uri) => attachment.mxc_uri = uri,
            Err(error) => tracing::warn!(
                event = %event.event_id,
                uri = %attachment.mxc_uri,
                %error,
                "could not move an attachment to the appserver"
            ),
        }
    }
}

/// Build the Roomy event for one op.
pub fn build_event(id: &RoomyEventId, room: &RoomyRoomId, op: &bridge_core::Op) -> Option<Event> {
    use roomy_events::extensions::{AuthorOverride, MatrixMessageOrigin, TimestampOverride};

    let event_ulid = id.to_ulid().ok()?;
    let room_ulid = Ulid::parse(room.as_str().to_string()).ok()?;

    match op {
        bridge_core::Op::Send {
            author,
            body,
            reply_to,
            timestamp: op_timestamp,
            origin,
            attachments,
            ..
        } => {
            let mut extensions = MessageExtensions {
                author_override: Some(AuthorOverride {
                    did: Did::parse(author.as_str().to_string()).ok()?,
                }),
                timestamp_override: Some(TimestampOverride {
                    timestamp: *op_timestamp,
                }),
                ..Default::default()
            };
            if let Some(origin) = origin {
                extensions.matrix_message_origin = Some(MatrixMessageOrigin {
                    room_id: origin.room_id.as_str().to_string(),
                    event_id: origin.event_id.as_ref().map(|id| id.as_str().to_string()),
                    origin_server_ts: origin.origin_server_ts,
                });
            }
            if reply_to.is_some() || !attachments.is_empty() {
                let mut list = Vec::new();
                if let Some(target) = reply_to {
                    if let Ok(target) = target.to_ulid() {
                        list.push(roomy_events::extensions::Reply { target }.into());
                    }
                }
                for media in attachments {
                    // A `mxc://` URI has not been uploaded yet; only an
                    // `atblob://` ref is a Roomy attachment.
                    if !media.uri.starts_with("atblob://") {
                        continue;
                    }
                    let attachment = if media.mime_type.starts_with("image/") {
                        roomy_events::extensions::ImageAttachment {
                            uri: media.uri.clone(),
                            mime_type: media.mime_type.clone(),
                            alt: None,
                            height: None,
                            width: None,
                            size: media.size,
                        }
                        .into()
                    } else if media.mime_type.starts_with("video/") {
                        roomy_events::extensions::VideoAttachment {
                            uri: media.uri.clone(),
                            mime_type: media.mime_type.clone(),
                            alt: None,
                            height: None,
                            width: None,
                            size: media.size,
                        }
                        .into()
                    } else {
                        roomy_events::extensions::FileAttachment {
                            uri: media.uri.clone(),
                            mime_type: media.mime_type.clone(),
                            name: media.name.clone(),
                            size: media.size,
                        }
                        .into()
                    };
                    list.push(attachment);
                }
                if !list.is_empty() {
                    extensions.attachments =
                        Some(roomy_events::extensions::AttachmentsExtension::new(list));
                }
            }

            Some(Event::in_room(
                event_ulid.clone(),
                room_ulid,
                EventKind::CreateMessage(roomy_events::CreateMessage {
                    body: Content::markdown(body),
                    extensions,
                }),
            ))
        }
        bridge_core::Op::Edit { target, body, .. } => Some(Event::in_room(
            event_ulid.clone(),
            room_ulid,
            EventKind::EditMessage(roomy_events::EditMessage {
                message_id: target.to_ulid().ok()?,
                previous: None,
                body: Content::markdown(body),
                extensions: None,
            }),
        )),
        bridge_core::Op::Redact { target, reason, .. } => Some(Event::in_room(
            event_ulid.clone(),
            room_ulid,
            EventKind::DeleteMessage(roomy_events::DeleteMessage {
                message_id: target.to_ulid().ok()?,
                reason: reason.clone(),
            }),
        )),
        bridge_core::Op::React {
            target,
            emoji,
            author,
            origin,
            ..
        } => {
            let mut bag = roomy_events::extensions::ExtensionBag::new();
            if let Some(origin) = origin {
                bag = bag.with_matrix_message_origin(&MatrixMessageOrigin {
                    room_id: origin.room_id.as_str().to_string(),
                    event_id: origin.event_id.as_ref().map(|id| id.as_str().to_string()),
                    origin_server_ts: origin.origin_server_ts,
                });
            }
            Some(Event::in_room(
                event_ulid.clone(),
                room_ulid,
                EventKind::AddBridgedReaction(roomy_events::AddBridgedReaction {
                    reaction_to: target.to_ulid().ok()?,
                    reaction: emoji.clone(),
                    reacting_user: Did::parse(author.as_str().to_string()).ok()?,
                    extensions: bag,
                }),
            ))
        }
        bridge_core::Op::Unreact {
            reaction_id,
            author,
            ..
        } => Some(Event::in_room(
            event_ulid.clone(),
            room_ulid,
            EventKind::RemoveBridgedReaction(roomy_events::RemoveBridgedReaction {
                reaction_id: reaction_id.to_ulid().ok()?,
                reacting_user: Did::parse(author.as_str().to_string()).ok()?,
                extensions: roomy_events::extensions::ExtensionBag::new(),
            }),
        )),
        bridge_core::Op::CreateRoom {
            name, kind, origin, ..
        } => {
            let room_kind = match kind {
                bridge_core::RoomyRoomKind::Channel => roomy_events::RoomKind::Channel,
                bridge_core::RoomyRoomKind::Thread => roomy_events::RoomKind::Thread,
                bridge_core::RoomyRoomKind::Category => roomy_events::RoomKind::Category,
            };
            Some(Event::in_space(
                event_ulid.clone(),
                EventKind::CreateRoom(roomy_events::CreateRoom {
                    kind: room_kind,
                    default_access: None,
                    name: Some(name.clone()),
                    avatar: None,
                    description: None,
                    extensions: Some(roomy_events::RoomExtensions::with_matrix_origin(
                        roomy_events::extensions::MatrixOrigin {
                            room_id: origin.room_id.as_str().to_string(),
                            event_id: origin.event_id.as_ref().map(|id| id.as_str().to_string()),
                            origin_server_ts: origin.origin_server_ts,
                        },
                    )),
                }),
            ))
        }
        bridge_core::Op::SetProfile {
            did,
            display_name,
            avatar_uri,
        } => Some(Event::in_space(
            event_ulid.clone(),
            EventKind::UpdateProfile(roomy_events::UpdateProfile {
                did: Did::parse(did.as_str().to_string()).ok()?,
                name: display_name.clone(),
                avatar: avatar_uri.clone(),
                description: None,
                extensions: None,
            }),
        )),
        // Backfill is not a Roomy event; it is a request to the homeserver and
        // is handled by the backfill task.
        bridge_core::Op::Backfill { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_core::{GhostDid, MatrixOrigin, MatrixRoomId, MediaRef, Op, RoomyRoomKind};

    fn event_id(value: &str) -> bridge_core::RoomyEventId {
        bridge_core::RoomyEventId::parse(value).unwrap()
    }

    fn room() -> RoomyRoomId {
        RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap()
    }

    fn ghost() -> GhostDid {
        GhostDid::parse("did:matrix:%40alice%3Aexample.org").unwrap()
    }

    fn id() -> bridge_core::RoomyEventId {
        bridge_core::RoomyEventId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD").unwrap()
    }

    #[test]
    fn a_send_carries_the_author_and_time_overrides() {
        let op = Op::Send {
            roomy_room_id: room(),
            author: ghost(),
            body: "hello".into(),
            attachments: vec![],
            reply_to: None,
            timestamp: 1_700_000_000_000,
            origin: Some(MatrixOrigin {
                room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
                event_id: Some(bridge_core::MatrixEventId::parse("$evt").unwrap()),
                origin_server_ts: Some(1_700_000_000_000),
            }),
        };
        let event = build_event(&id(), &room(), &op).unwrap();
        let json = event.to_json();
        assert_eq!(json["$type"], roomy_events::nsid::CREATE_MESSAGE);
        assert_eq!(
            json["extensions"]["space.roomy.extension.authorOverride.v0"]["did"],
            "did:matrix:%40alice%3Aexample.org"
        );
        assert_eq!(
            json["extensions"]["space.roomy.extension.timestampOverride.v0"]["timestamp"],
            1_700_000_000_000i64
        );
        assert_eq!(
            json["extensions"]["space.roomy.extension.matrixMessageOrigin.v0"]["eventId"],
            "$evt"
        );
    }

    #[test]
    fn a_reply_becomes_a_reply_attachment() {
        let op = Op::Send {
            roomy_room_id: room(),
            author: ghost(),
            body: "yes".into(),
            attachments: vec![],
            reply_to: Some(event_id("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF")),
            timestamp: 0,
            origin: None,
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(
            json["extensions"]["space.roomy.extension.attachments.v0"]["attachments"][0]["$type"],
            "space.roomy.attachment.reply.v0"
        );
    }

    #[test]
    fn an_mxc_uri_is_not_emitted_as_an_attachment() {
        // An `mxc://` URI the adapter has not uploaded yet is not a Roomy
        // attachment; emitting it would produce a card pointing at a URI no
        // reader can fetch.
        let op = Op::Send {
            roomy_room_id: room(),
            author: ghost(),
            body: "photo".into(),
            attachments: vec![MediaRef {
                uri: "mxc://media.example.org/abc".into(),
                mime_type: "image/png".into(),
                name: None,
                size: None,
            }],
            reply_to: None,
            timestamp: 0,
            origin: None,
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert!(
            json["extensions"]["space.roomy.extension.attachments.v0"].is_null(),
            "an un-uploaded mxc:// URI must not be emitted"
        );
    }

    #[test]
    fn an_uploaded_blob_becomes_an_image_attachment() {
        let op = Op::Send {
            roomy_room_id: room(),
            author: ghost(),
            body: "photo".into(),
            attachments: vec![MediaRef {
                uri: "atblob://did:plc:bridge/cid".into(),
                mime_type: "image/png".into(),
                name: Some("photo.png".into()),
                size: Some(123),
            }],
            reply_to: None,
            timestamp: 0,
            origin: None,
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(
            json["extensions"]["space.roomy.extension.attachments.v0"]["attachments"][0]["$type"],
            "space.roomy.attachment.image.v0"
        );
    }

    #[test]
    fn an_edit_addresses_the_target_message() {
        let op = Op::Edit {
            roomy_room_id: room(),
            target: event_id("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF"),
            body: "corrected".into(),
            timestamp: 1,
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(json["$type"], roomy_events::nsid::EDIT_MESSAGE);
        assert_eq!(json["messageId"], "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF");
    }

    #[test]
    fn a_redaction_deletes_the_target() {
        let op = Op::Redact {
            roomy_room_id: room(),
            target: event_id("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF"),
            reason: Some("spam".into()),
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(json["$type"], roomy_events::nsid::DELETE_MESSAGE);
        assert_eq!(json["reason"], "spam");
    }

    #[test]
    fn a_room_is_created_with_its_matrix_origin() {
        let op = Op::CreateRoom {
            roomy_room_id: room(),
            name: "General".into(),
            kind: RoomyRoomKind::Channel,
            parent: None,
            origin: MatrixOrigin {
                room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
                event_id: None,
                origin_server_ts: Some(5),
            },
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(json["$type"], roomy_events::nsid::CREATE_ROOM);
        assert_eq!(json["kind"], "space.roomy.channel");
        assert_eq!(
            json["extensions"]["space.roomy.extension.matrixOrigin.v0"]["roomId"],
            "!room:example.org"
        );
        // A room event is scoped to the space, not to a room.
        assert!(json.get("room").is_none());
    }

    #[test]
    fn a_reaction_is_attributed_to_the_reacting_ghost() {
        let op = Op::React {
            roomy_room_id: room(),
            target: event_id("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF"),
            emoji: "🎉".into(),
            author: ghost(),
            origin: None,
        };
        let json = build_event(&id(), &room(), &op).unwrap().to_json();
        assert_eq!(json["$type"], roomy_events::nsid::ADD_BRIDGED_REACTION);
        assert_eq!(json["reactingUser"], "did:matrix:%40alice%3Aexample.org");
        assert_eq!(json["reaction"], "🎉");
    }

    // ── Media ────────────────────────────────────────────────────────────────

    /// A homeserver serving one image and a PDS accepting an upload, both on a
    /// throwaway port.
    async fn media_endpoints(serve_media: bool) -> (MediaStore, AppserverClient) {
        use axum::response::IntoResponse;

        let media = axum::routing::get(move || async move {
            if serve_media {
                (
                    [(axum::http::header::CONTENT_TYPE, "image/png")],
                    [0x89u8, b'P', b'N', b'G'],
                )
                    .into_response()
            } else {
                axum::http::StatusCode::NOT_FOUND.into_response()
            }
        });
        let upload = axum::routing::post(|| async {
            axum::Json(serde_json::json!({
                "blob": { "ref": { "$link": "bafkreiphotograph" } }
            }))
        });
        let app = axum::Router::new()
            .route("/_matrix/client/v1/media/download/{server}/{media}", media)
            .route("/xrpc/com.atproto.repo.uploadBlob", upload);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port is free");
        let base = format!("http://{}", listener.local_addr().expect("bound"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let media_store = MediaStore::new(
            &base,
            matrix_adapter::AsToken::parse("as-token").unwrap(),
            &base,
        );
        let appserver = AppserverClient::new(
            &base,
            Did::parse("did:web:appserver.example").unwrap(),
            Arc::new(roomy_client::ServiceAuth::new(&base)),
            "access-jwt",
        )
        .with_pds_url(&base);
        (media_store, appserver)
    }

    fn image_event() -> IncomingEvent {
        IncomingEvent {
            event_id: bridge_core::MatrixEventId::parse("$photo").unwrap(),
            room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
            sender: bridge_core::GhostMxid::parse("@_roomy_alice:example.org").unwrap(),
            origin_server_ts: 0,
            kind: IncomingKind::Message {
                body: bridge_core::Body::plain("look"),
                media: vec![bridge_core::IncomingMedia {
                    mxc_uri: "mxc://media.example.org/abc".into(),
                    mime_type: "image/png".into(),
                    name: Some("photo.png".into()),
                    size: Some(4),
                    msgtype: bridge_core::Msgtype::Image,
                }],
                reply_to: None,
                thread_root: None,
            },
            encrypted: false,
        }
    }

    fn attachment_uris(event: &IncomingEvent) -> Vec<String> {
        let IncomingKind::Message { media, .. } = &event.kind else {
            return Vec::new();
        };
        media.iter().map(|media| media.mxc_uri.clone()).collect()
    }

    #[tokio::test]
    async fn an_mxc_attachment_is_uploaded_and_named_as_a_blob() {
        let (media_store, appserver) = media_endpoints(true).await;
        let owner = Did::parse("did:web:bridge.example").unwrap();
        let mut event = image_event();

        host_attachments(&media_store, &appserver, &owner, &mut event).await;

        assert_eq!(
            attachment_uris(&event),
            vec!["atblob://did:web:bridge.example/bafkreiphotograph".to_string()]
        );

        // What Roomy sees is a message attachment, not a URI it cannot fetch.
        let portal = bridge_core::Portal {
            id: bridge_core::PortalId::new(
                bridge_core::SpaceDid::parse("did:plc:space").unwrap(),
                MatrixRoomId::parse("!room:example.org").unwrap(),
            ),
            roomy_room_id: room(),
            depth: 1,
            name: None,
            encryption: bridge_core::PortalEncryption::plain(),
            state: bridge_core::PortalState::Syncing,
            created_at: 0,
        };
        let mut state = BridgeState::new();
        let Step::Accepted(writes) = bridge_core::step(
            &mut state,
            Input::Matrix {
                event: &event,
                portal: &portal,
                ghost: &GhostDid::from(&event.sender),
            },
            0,
        ) else {
            panic!("the message is not an echo");
        };
        let json = writes
            .iter()
            .find_map(|write| build_event(write.id(), &room(), write.op()))
            .expect("the message becomes a Roomy event")
            .to_json();
        assert_eq!(json["$type"], roomy_events::nsid::CREATE_MESSAGE);
        assert_eq!(
            json["extensions"]["space.roomy.extension.attachments.v0"]["attachments"][0]["$type"],
            "space.roomy.attachment.image.v0"
        );
        assert_eq!(
            json["extensions"]["space.roomy.extension.attachments.v0"]["attachments"][0]["uri"],
            "atblob://did:web:bridge.example/bafkreiphotograph"
        );
    }

    #[tokio::test]
    async fn a_failed_download_leaves_the_attachment_and_the_body_alone() {
        let (media_store, appserver) = media_endpoints(false).await;
        let owner = Did::parse("did:web:bridge.example").unwrap();
        let mut event = image_event();

        host_attachments(&media_store, &appserver, &owner, &mut event).await;

        assert_eq!(
            attachment_uris(&event),
            vec!["mxc://media.example.org/abc".to_string()]
        );
        // The message itself is untouched, so its text still reaches Roomy even
        // though the attachment is dropped.
        assert_eq!(event.kind, image_event().kind);
    }
}
