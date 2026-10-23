//! Roomy → Matrix translation.
//!
//! The rules here mirror the inbound direction, with one asymmetry worth
//! naming: Matrix has no author override, so a Roomy message is attributed only
//! by *which MXID sends it*. That is the whole reason ghosts exist.

use bridge_core::{
    BridgeState, GhostMxid, MappingKind, MatrixEventId, MatrixMedia, MatrixOp, MatrixRoomId,
    MediaRef, Portal,
};
use matrix_adapter::{GhostRegistry, OutgoingContent};
use roomy_events::extensions::{Attachment, AttachmentsExtension};
use roomy_events::{Did, Event, EventKind};

/// Translate one Roomy event into a Matrix op.
///
/// Returns `None` when the event is the bridge's own echo, is not addressed to
/// the portal's room, or has no Matrix counterpart.
pub fn to_matrix_op(
    event: &Event,
    portal: &Portal,
    ghosts: &GhostRegistry,
    state: &BridgeState,
    _max_depth: u32,
) -> Option<MatrixOp> {
    // Echo suppression, second signal: an event carrying a Matrix origin was
    // written by this bridge, whatever the id map says.
    let carries_matrix_origin = match &event.kind {
        EventKind::CreateMessage(message) => message.extensions.matrix_origin().is_some(),
        EventKind::AddBridgedReaction(reaction) => reaction.extensions.matrix_origin().is_some(),
        EventKind::RemoveBridgedReaction(reaction) => reaction.extensions.matrix_origin().is_some(),
        _ => false,
    };
    if carries_matrix_origin {
        return None;
    }

    match &event.kind {
        EventKind::CreateMessage(message) => {
            // The sender must be the ghost the bridge minted for this author,
            // not the author's own MXID: a Roomy user is `did:plc:…`, and their
            // Matrix counterpart is the ghost the registry created. Sending as
            // anything else either fails (no such local user) or attributes the
            // message to the wrong person.
            let author = message.extensions.author_override.as_ref()?.did.clone();
            let mxid = ghosts.mxid_of(&author).cloned();
            let body = message.body.as_text().unwrap_or_default().to_string();
            if body.is_empty() {
                return None;
            }

            let reply_to = message
                .extensions
                .attachments
                .as_ref()
                .and_then(AttachmentsExtension::reply_target);

            Some(MatrixOp::Send {
                matrix_room_id: portal.matrix_room_id().clone(),
                sender: mxid,
                body,
                media: Vec::new(),
                reply_to: reply_to
                    .and_then(|target| MatrixEventId::parse(format!("${target}")).ok()),
            })
        }
        EventKind::EditMessage(edit) => {
            // Matrix addresses events by event id; the Roomy target is a ULID
            // the bridge must map back through its id table.
            let target = MatrixEventId::parse(format!("${}", edit.message_id)).ok()?;
            Some(MatrixOp::Edit {
                matrix_room_id: portal.matrix_room_id().clone(),
                target,
                body: edit.body.as_text().unwrap_or_default().to_string(),
            })
        }
        EventKind::DeleteMessage(delete) => Some(MatrixOp::Redact {
            matrix_room_id: portal.matrix_room_id().clone(),
            target: MatrixEventId::parse(format!("${}", delete.message_id)).ok()?,
            reason: delete.reason.clone(),
        }),
        EventKind::AddBridgedReaction(reaction) => {
            // A re-materialised reaction is an echo even when it lost its
            // origin: the id map recorded the event the bridge wrote.
            if state
                .matrix_id(MappingKind::Reaction, event.id.as_str())
                .is_some()
            {
                return None;
            }
            let target = MatrixEventId::parse(
                state.matrix_id(MappingKind::Message, reaction.reaction_to.as_str())?,
            )
            .ok()?;
            Some(MatrixOp::React {
                matrix_room_id: portal.matrix_room_id().clone(),
                target,
                key: reaction.reaction.clone(),
                sender: ghost_mxid(ghosts, reaction.reacting_user.as_str()),
            })
        }
        EventKind::RemoveBridgedReaction(reaction) => {
            // The reaction's own Roomy id was mapped to the Matrix reaction
            // event when the bridge wrote it; redacting that event removes the
            // annotation. A removal the bridge wrote is itself an echo.
            if state
                .matrix_id(MappingKind::Reaction, event.id.as_str())
                .is_some()
            {
                return None;
            }
            let target = MatrixEventId::parse(
                state.matrix_id(MappingKind::Reaction, reaction.reaction_id.as_str())?,
            )
            .ok()?;
            Some(MatrixOp::Unreact {
                matrix_room_id: portal.matrix_room_id().clone(),
                target,
                sender: ghost_mxid(ghosts, reaction.reacting_user.as_str()),
            })
        }
        _ => None,
    }
}

/// The ghost MXID for a Roomy DID, if the registry has one.
fn ghost_mxid(ghosts: &GhostRegistry, did: &str) -> Option<GhostMxid> {
    let did = Did::parse(did.to_string()).ok()?;
    ghosts.mxid_of(&did).cloned()
}

/// The attachments a Roomy message carries that Matrix can fetch.
///
/// Only `atblob://` refs qualify: the appserver's blob proxy serves those
/// bytes, while the bridge has no authenticated route to any other URI.
pub fn attachment_refs(event: &Event) -> Vec<MediaRef> {
    let EventKind::CreateMessage(message) = &event.kind else {
        return Vec::new();
    };
    let Some(attachments) = message.extensions.attachments.as_ref() else {
        return Vec::new();
    };

    attachments
        .attachments
        .iter()
        .filter_map(|attachment| match attachment {
            Attachment::Image(image) => Some(MediaRef {
                uri: image.uri.clone(),
                mime_type: image.mime_type.clone(),
                name: None,
                size: image.size,
            }),
            Attachment::Video(video) => Some(MediaRef {
                uri: video.uri.clone(),
                mime_type: video.mime_type.clone(),
                name: None,
                size: video.size,
            }),
            Attachment::File(file) => Some(MediaRef {
                uri: file.uri.clone(),
                mime_type: file.mime_type.clone(),
                name: file.name.clone(),
                size: file.size,
            }),
            Attachment::Reply(_) => None,
        })
        .filter(|reference| reference.uri.starts_with("atblob://"))
        .collect()
}

/// The content to send for an op, which is where the Matrix relation shape is
/// decided.
///
/// `media` is the already-uploaded attachment set for a send; it is empty for
/// every other op and for a send without attachments.
pub fn content_for(op: &MatrixOp, media: &[MatrixMedia]) -> Option<OutgoingContent> {
    match op {
        MatrixOp::Send { body, reply_to, .. } => Some(match media.first() {
            // The attachment's name is the body a Matrix client shows beside
            // the file; a message with no name falls back to its text.
            Some(first) => matrix_adapter::media_content(
                first.name.as_deref().unwrap_or(body),
                &first.mxc_uri,
                &first.mime_type,
            ),
            None => match reply_to {
                Some(target) => matrix_adapter::reply_content(target.as_str(), body),
                None => matrix_adapter::text_content(body),
            },
        }),
        MatrixOp::Edit { target, body, .. } => {
            Some(matrix_adapter::edit_content(target.as_str(), body))
        }
        MatrixOp::Redact { target, reason, .. } => Some(matrix_adapter::redaction_content(
            target.as_str(),
            reason.as_deref(),
        )),
        MatrixOp::React { target, key, .. } => {
            Some(matrix_adapter::reaction_content(target.as_str(), key))
        }
        MatrixOp::Unreact { target, .. } => {
            Some(matrix_adapter::redaction_content(target.as_str(), None))
        }
        MatrixOp::JoinAsGhost { .. } => None,
    }
}

/// The MXID a Matrix op sends as.
pub fn sender_of(op: &MatrixOp) -> Option<&str> {
    match op {
        MatrixOp::Send { sender, .. }
        | MatrixOp::React { sender, .. }
        | MatrixOp::Unreact { sender, .. } => sender.as_ref().map(|mxid| mxid.as_str()),
        _ => None,
    }
}

/// The room a Matrix op addresses.
pub fn room_of(op: &MatrixOp) -> Option<&MatrixRoomId> {
    match op {
        MatrixOp::Send { matrix_room_id, .. }
        | MatrixOp::Edit { matrix_room_id, .. }
        | MatrixOp::Redact { matrix_room_id, .. }
        | MatrixOp::React { matrix_room_id, .. }
        | MatrixOp::Unreact { matrix_room_id, .. }
        | MatrixOp::JoinAsGhost { matrix_room_id, .. } => Some(matrix_room_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roomy_events::extensions::{AuthorOverride, ImageAttachment, MatrixMessageOrigin, Reply};
    use roomy_events::{
        AddBridgedReaction, Content, CreateMessage, MessageExtensions, RemoveBridgedReaction, Ulid,
    };

    fn portal() -> Portal {
        Portal {
            id: bridge_core::PortalId::new(
                bridge_core::SpaceDid::parse("did:plc:space").unwrap(),
                MatrixRoomId::parse("!room:example.org").unwrap(),
            ),
            roomy_room_id: bridge_core::RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: None,
            encryption: bridge_core::PortalEncryption::plain(),
            state: bridge_core::PortalState::Syncing,
            created_at: 0,
        }
    }

    fn registry() -> GhostRegistry {
        let mut registry = GhostRegistry::new("matrix.roomy.local");
        registry
            .register(
                &Did::parse("did:matrix:%40alice%3Aexample.org").unwrap(),
                None,
                None,
            )
            .unwrap();
        registry
    }

    fn message_event(extensions: MessageExtensions) -> Event {
        Event::in_room(
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD").unwrap(),
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            EventKind::CreateMessage(CreateMessage {
                body: Content::markdown("hello"),
                extensions,
            }),
        )
    }

    fn ghost_extension() -> MessageExtensions {
        MessageExtensions {
            author_override: Some(AuthorOverride {
                did: roomy_events::Did::parse("did:matrix:%40alice%3Aexample.org").unwrap(),
            }),
            ..Default::default()
        }
    }

    fn message_mapping() -> BridgeState {
        let mut state = BridgeState::new();
        state.record_mapping(bridge_core::Mapping {
            kind: MappingKind::Message,
            matrix_id: "$matrix-msg".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF".into(),
            created_at: 0,
        });
        state
    }

    fn reaction_event(kind: EventKind) -> Event {
        Event::in_room(
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0GH").unwrap(),
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            kind,
        )
    }

    fn add_reaction() -> EventKind {
        EventKind::AddBridgedReaction(AddBridgedReaction {
            reaction_to: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF").unwrap(),
            reaction: "🎉".into(),
            reacting_user: roomy_events::Did::parse("did:matrix:%40alice%3Aexample.org").unwrap(),
            extensions: roomy_events::extensions::ExtensionBag::new(),
        })
    }

    #[test]
    fn a_message_becomes_a_send_as_the_authors_ghost() {
        let op = to_matrix_op(
            &message_event(ghost_extension()),
            &portal(),
            &registry(),
            &BridgeState::new(),
            2,
        )
        .unwrap();
        match op {
            MatrixOp::Send { sender, body, .. } => {
                let sender = sender.expect("a ghost sender");
                assert!(sender.as_str().starts_with("@_roomy_"));
                assert!(sender.as_str().ends_with(":matrix.roomy.local"));
                assert_eq!(body, "hello");
            }
            other => panic!("expected a send, got {other:?}"),
        }
    }

    #[test]
    fn an_event_with_a_matrix_origin_is_an_echo() {
        let mut extensions = ghost_extension();
        extensions.matrix_message_origin = Some(MatrixMessageOrigin {
            room_id: "!room:example.org".into(),
            event_id: Some("$evt".into()),
            origin_server_ts: Some(1),
        });
        assert!(to_matrix_op(
            &message_event(extensions),
            &portal(),
            &registry(),
            &BridgeState::new(),
            2
        )
        .is_none());
    }

    #[test]
    fn an_event_without_an_author_override_is_not_relayed() {
        // Every bridged message carries an author override; one that does not
        // was written by a Roomy user with no Matrix counterpart, and sending
        // it as the bridge would attribute it wrongly.
        assert!(to_matrix_op(
            &message_event(MessageExtensions::default()),
            &portal(),
            &registry(),
            &BridgeState::new(),
            2
        )
        .is_none());
    }

    #[test]
    fn a_reply_becomes_a_reply_relation() {
        let mut extensions = ghost_extension();
        extensions.attachments = Some(AttachmentsExtension::new(vec![Reply {
            target: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF").unwrap(),
        }
        .into()]));
        let op = to_matrix_op(
            &message_event(extensions),
            &portal(),
            &registry(),
            &BridgeState::new(),
            2,
        )
        .unwrap();
        let json = serde_json::to_value(content_for(&op, &[]).unwrap().content).unwrap();
        assert_eq!(
            json["m.relates_to"]["m.in_reply_to"]["event_id"],
            "$01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF"
        );
    }

    #[test]
    fn a_roomy_reaction_becomes_a_react_as_the_reacting_ghost() {
        let op = to_matrix_op(
            &reaction_event(add_reaction()),
            &portal(),
            &registry(),
            &message_mapping(),
            2,
        )
        .unwrap();
        match op {
            MatrixOp::React {
                target,
                key,
                sender,
                ..
            } => {
                assert_eq!(target.as_str(), "$matrix-msg");
                assert_eq!(key, "🎉");
                let sender = sender.expect("a ghost sender");
                assert!(sender.as_str().starts_with("@_roomy_"));
            }
            other => panic!("expected a react, got {other:?}"),
        }
    }

    #[test]
    fn a_reaction_with_no_mapped_target_yields_no_op() {
        assert!(to_matrix_op(
            &reaction_event(add_reaction()),
            &portal(),
            &registry(),
            &BridgeState::new(),
            2
        )
        .is_none());
    }

    #[test]
    fn removing_a_roomy_reaction_redacts_the_matrix_reaction() {
        let mut state = message_mapping();
        state.record_mapping(bridge_core::Mapping {
            kind: MappingKind::Reaction,
            matrix_id: "$matrix-reaction".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0JK".into(),
            created_at: 0,
        });
        let event = reaction_event(EventKind::RemoveBridgedReaction(RemoveBridgedReaction {
            reaction_id: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0JK").unwrap(),
            reacting_user: roomy_events::Did::parse("did:matrix:%40alice%3Aexample.org").unwrap(),
            extensions: roomy_events::extensions::ExtensionBag::new(),
        }));
        let op = to_matrix_op(&event, &portal(), &registry(), &state, 2).unwrap();
        match op {
            MatrixOp::Unreact { target, sender, .. } => {
                assert_eq!(target.as_str(), "$matrix-reaction");
                assert!(sender.is_some());
            }
            other => panic!("expected an unreact, got {other:?}"),
        }
    }

    #[test]
    fn an_image_attachment_becomes_media_content() {
        let mut extensions = ghost_extension();
        extensions.attachments = Some(AttachmentsExtension::new(vec![ImageAttachment {
            uri: "atblob://did:plc:bridge/cid".into(),
            mime_type: "image/png".into(),
            alt: None,
            height: None,
            width: None,
            size: Some(4),
        }
        .into()]));
        let event = message_event(extensions);

        let refs = attachment_refs(&event);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].uri, "atblob://did:plc:bridge/cid");
        assert_eq!(refs[0].mime_type, "image/png");

        // Resolution uploads the bytes; content is built from the result.
        let media = vec![MatrixMedia {
            mxc_uri: "mxc://matrix.roomy.local/abc".into(),
            mime_type: "image/png".into(),
            name: None,
            size: Some(4),
        }];
        let op = to_matrix_op(&event, &portal(), &registry(), &BridgeState::new(), 2).unwrap();
        let content = content_for(&op, &media).unwrap();
        assert_eq!(content.event_type, "m.room.message");
        assert_eq!(content.content["msgtype"], "m.image");
        assert_eq!(content.content["url"], "mxc://matrix.roomy.local/abc");
        assert_eq!(content.content["info"]["mimetype"], "image/png");
    }
}
