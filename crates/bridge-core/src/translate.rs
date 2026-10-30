//! Inbound translation: a platform-neutral incoming event → Roomy ops.
//!
//! The input type is Matrix-shaped because that is the direction Matrix flows
//! (the reverse is [`crate::op::MatrixOp`]), but it carries no Matrix-specific
//! machinery: no ruma types, no signatures, no HTTP. An adapter produces
//! [`IncomingEvent`] values; this module decides what they mean.
//!
//! Ordering rules that live here rather than in an adapter:
//!
//! * **Edits are last-writer-wins by `origin_server_ts`.** A homeserver can
//!   deliver an older edit after a newer one (federation, retry on a different
//!   appservice transaction). Applying them in delivery order would leave the
//!   stale body as the final state, so an edit older than the newest one
//!   already applied is dropped.
//! * **A redaction of a reaction is an unreact, not a delete.** Both arrive as
//!   `m.room.redaction`; the id map says which the target was.
//! * **Replies become `attachment.reply.v0`** only when the target is bridged;
//!   an unbridged target becomes a plain message, because a reply to a ULID the
//!   space does not have renders as a dangling reference.

use std::collections::HashMap;

use crate::dedupe::{Dedupe, EchoDecision, MappingKind};
use crate::ids::{GhostDid, GhostMxid, MatrixEventId, MatrixRoomId, RoomyEventId, RoomyRoomId};
use crate::op::{MatrixOrigin, MediaRef, Op};
use crate::portal::Portal;
use crate::state::Rejection;
use crate::Millis;

/// A message body as it arrived, with the formatted variant when the sender
/// provided one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    /// The plain-text body.
    pub text: String,
    /// `formatted_body`, when present. Matrix clients send HTML here.
    pub formatted: Option<FormattedBody>,
}

/// A formatted body and its format, normally `org.matrix.custom.html`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormattedBody {
    /// The format name, normally `org.matrix.custom.html`.
    pub format: String,
    /// The formatted body itself.
    pub body: String,
}

impl Body {
    /// A body with no formatted variant.
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            formatted: None,
        }
    }
}

/// Media referenced by an incoming message, not yet uploaded anywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingMedia {
    /// The `mxc://` URI the Matrix content names.
    pub mxc_uri: String,
    /// The media's MIME type.
    pub mime_type: String,
    /// The file name, when the event carries one.
    pub name: Option<String>,
    /// The size in bytes, when the event carries it.
    pub size: Option<u64>,
    /// The Matrix `msgtype`, which decides whether the attachment is an image,
    /// a video, or a file.
    pub msgtype: Msgtype,
}

/// The Matrix message types the bridge distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msgtype {
    /// `m.text`.
    Text,
    /// `m.emote`.
    Emote,
    /// `m.notice`.
    Notice,
    /// `m.image`.
    Image,
    /// `m.video`.
    Video,
    /// `m.audio`.
    Audio,
    /// `m.file`.
    File,
}

impl Msgtype {
    /// Whether the content carries an `mxc://` reference.
    pub fn has_media(self) -> bool {
        matches!(
            self,
            Msgtype::Image | Msgtype::Video | Msgtype::Audio | Msgtype::File
        )
    }
}

/// What an incoming event is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingKind {
    /// A message, possibly with media and possibly a reply.
    Message {
        /// The message body, with its formatted variant when present.
        body: Body,
        /// Media the message references.
        media: Vec<IncomingMedia>,
        /// `m.in_reply_to` target, when the content names one.
        reply_to: Option<MatrixEventId>,
        /// Root of an `m.thread` relation, when the content names one.
        thread_root: Option<MatrixEventId>,
    },
    /// `m.replace`: a new body for `target`.
    Edit {
        /// The Matrix event being edited.
        target: MatrixEventId,
        /// The new body.
        body: Body,
    },
    /// `m.room.redaction`. The target may be a message or a reaction; the id
    /// map decides which.
    Redaction {
        /// The Matrix event being redacted; a message or a reaction.
        target: MatrixEventId,
        /// The reason recorded with the redaction.
        reason: Option<String>,
    },
    /// `m.annotation` reaction.
    Reaction {
        /// The Matrix event being reacted to.
        target: MatrixEventId,
        /// The reaction key, e.g. an emoji.
        key: String,
    },
}

/// One decrypted event handed to the state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingEvent {
    /// The Matrix event id.
    pub event_id: MatrixEventId,
    /// The Matrix room the event happened in.
    pub room_id: MatrixRoomId,
    /// The Matrix user that sent it, as their ghost MXID.
    pub sender: GhostMxid,
    /// The event's origin timestamp, in milliseconds.
    pub origin_server_ts: Millis,
    /// What the event is.
    pub kind: IncomingKind,
    /// Whether the event arrived inside an encrypted room, so the caller can
    /// mark a portal blocked when a key is missing.
    pub encrypted: bool,
}

/// The edit-ordering guard: the newest `origin_server_ts` applied per target.
///
/// Kept beside the translation rather than inside it so the state survives
/// across events — a translation is a pure function of one event, but "is this
/// edit older than the last one I applied" is a function of history.
#[derive(Debug, Clone, Default)]
pub struct EditOrder {
    applied: HashMap<(MatrixRoomId, MatrixEventId), Millis>,
}

impl EditOrder {
    /// Record an edit that was applied.
    pub fn record(&mut self, room: &MatrixRoomId, target: &MatrixEventId, ts: Millis) {
        let entry = self
            .applied
            .entry((room.clone(), target.clone()))
            .or_insert(ts);
        if ts > *entry {
            *entry = ts;
        }
    }

    /// Whether an edit stamped `ts` supersedes what is already applied.
    pub fn accepts(&self, room: &MatrixRoomId, target: &MatrixEventId, ts: Millis) -> bool {
        match self.applied.get(&(room.clone(), target.clone())) {
            // A same-millisecond edit is accepted: Matrix timestamps are
            // millisecond-resolution and two edits in one millisecond are far
            // more likely to be a re-delivery ordering quirk than a genuinely
            // concurrent pair; taking the later delivery is the safer choice.
            Some(applied) => ts >= *applied,
            None => true,
        }
    }
}

/// One thing to write for an accepted input, and the pairing it establishes.
///
/// A decision carries no id and no timestamp: [`crate::step`] mints the Roomy
/// event id and records the pairing, so translation stays a pure function of
/// the event and the machine's memory.
#[derive(Debug)]
pub(crate) struct Decision {
    pub(crate) op: Op,
    pub(crate) kind: MappingKind,
}

impl Decision {
    fn write(op: Op, kind: MappingKind) -> Self {
        Self { op, kind }
    }
}

/// Translate one incoming event into the writes it implies.
///
/// The caller gets a `Result` rather than an empty vector: "the bridge already
/// applied this" must be distinguishable from "this event means nothing to
/// Roomy", or a caller would re-post a redelivered transaction.
pub(crate) fn translate(
    event: &IncomingEvent,
    portal: &Portal,
    ghost_did: &GhostDid,
    dedupe: &Dedupe,
    edits: &mut EditOrder,
) -> Result<Vec<Decision>, Rejection> {
    match dedupe.classify_matrix(event.event_id.as_str(), None) {
        EchoDecision::Relay => {}
        EchoDecision::Echo => return Err(Rejection::Echo),
        EchoDecision::Duplicate => return Err(Rejection::Duplicate),
    }

    let origin = MatrixOrigin {
        room_id: event.room_id.clone(),
        event_id: Some(event.event_id.clone()),
        origin_server_ts: Some(event.origin_server_ts),
    };

    match &event.kind {
        IncomingKind::Message {
            body,
            media,
            reply_to,
            thread_root,
        } => {
            // A thread root that is bridged means the message belongs in the
            // thread's Roomy channel, if one exists; otherwise it is flattened
            // into the channel as an ordinary message (a reply when the root is
            // bridged, plain otherwise).
            let target_room = thread_root
                .as_ref()
                .and_then(|root| dedupe.roomy_id(MappingKind::Room, root.as_str()))
                .and_then(|roomy_id| RoomyRoomId::parse(roomy_id).ok())
                .unwrap_or_else(|| portal.roomy_room_id.clone());

            // A reply only becomes a reply attachment when its target exists in
            // this space. A dangling `reply` renders as a broken quote, which is
            // worse than the plain message the reader can still act on.
            // A thread message whose thread has no Roomy room belongs in the
            // channel as a reply to the thread's root, which is where a reader
            // would look for it.
            let reply_target = reply_to
                .as_ref()
                .or(thread_root.as_ref())
                .and_then(|target| dedupe.roomy_id(MappingKind::Message, target.as_str()))
                .and_then(|roomy_id| RoomyEventId::parse(roomy_id).ok());

            Ok(vec![Decision::write(
                Op::Send {
                    roomy_room_id: target_room,
                    author: ghost_did.clone(),
                    body: markdown_body(body),
                    attachments: media
                        .iter()
                        .map(|item| MediaRef {
                            // The adapter uploads and rewrites this to an
                            // `atblob://` ref before the op reaches the appserver.
                            uri: item.mxc_uri.clone(),
                            mime_type: item.mime_type.clone(),
                            name: item.name.clone(),
                            size: item.size,
                        })
                        .collect(),
                    reply_to: reply_target,
                    timestamp: event.origin_server_ts,
                    origin: Some(origin),
                },
                MappingKind::Message,
            )])
        }
        IncomingKind::Edit { target, body } => {
            if !edits.accepts(&event.room_id, target, event.origin_server_ts) {
                return Err(Rejection::Superseded);
            }
            let Some(roomy_target) = dedupe
                .roomy_id(MappingKind::Message, target.as_str())
                .and_then(|roomy_id| RoomyEventId::parse(roomy_id).ok())
            else {
                // An edit for a message the space does not have is not
                // representable: Roomy has no message to edit.
                return Err(Rejection::NotBridged);
            };
            edits.record(&event.room_id, target, event.origin_server_ts);
            Ok(vec![Decision::write(
                Op::Edit {
                    roomy_room_id: portal.roomy_room_id.clone(),
                    target: roomy_target,
                    body: markdown_body(body),
                    timestamp: event.origin_server_ts,
                },
                MappingKind::Edit,
            )])
        }
        IncomingKind::Redaction { target, reason } => {
            if let Some(roomy_target) = dedupe
                .roomy_id(MappingKind::Message, target.as_str())
                .and_then(|roomy_id| RoomyEventId::parse(roomy_id).ok())
            {
                return Ok(vec![Decision::write(
                    Op::Redact {
                        roomy_room_id: portal.roomy_room_id.clone(),
                        target: roomy_target,
                        reason: reason.clone(),
                    },
                    MappingKind::Redaction,
                )]);
            }
            if let Some(reaction_id) = dedupe
                .roomy_id(MappingKind::Reaction, target.as_str())
                .and_then(|roomy_id| RoomyEventId::parse(roomy_id).ok())
            {
                // Redacting the *reaction* removes it; the message it annotated
                // is untouched.
                return Ok(vec![Decision::write(
                    Op::Unreact {
                        roomy_room_id: portal.roomy_room_id.clone(),
                        reaction_id,
                        author: ghost_did.clone(),
                    },
                    MappingKind::Reaction,
                )]);
            }
            Err(Rejection::NotBridged)
        }
        IncomingKind::Reaction { target, key } => {
            let Some(roomy_target) = dedupe
                .roomy_id(MappingKind::Message, target.as_str())
                .and_then(|roomy_id| RoomyEventId::parse(roomy_id).ok())
            else {
                return Err(Rejection::NotBridged);
            };
            Ok(vec![Decision::write(
                Op::React {
                    roomy_room_id: portal.roomy_room_id.clone(),
                    target: roomy_target,
                    emoji: key.clone(),
                    author: ghost_did.clone(),
                    origin: Some(origin),
                },
                MappingKind::Reaction,
            )])
        }
    }
}

/// The markdown Roomy renders for a Matrix body.
///
/// Matrix carries HTML in `formatted_body` with a plain-text fallback. Roomy
/// renders markdown, so the HTML is converted rather than passed through: a
/// `m.text` with `formatted_body` would otherwise lose its emphasis, and
/// passing the HTML verbatim would render as escaped tags.
fn markdown_body(body: &Body) -> String {
    match &body.formatted {
        Some(formatted) if formatted.format == "org.matrix.custom.html" => {
            html_to_markdown(&formatted.body).unwrap_or_else(|| body.text.clone())
        }
        _ => body.text.clone(),
    }
}

/// Convert the HTML subset Matrix clients emit into markdown.
///
/// Matrix's HTML is emitted by its own clients and is a small, regular subset:
/// `strong`/`b`, `em`/`i`, `del`/`s`, `code`, `pre`, `a href`, `br`, `p`, and
/// `mx-reply` blocks the bridge drops (they duplicate the reply target it has
/// already resolved). Anything outside that subset loses its formatting but
/// keeps its text, so an unrecognised tag never costs content.
fn html_to_markdown(html: &str) -> Option<String> {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    // `<mx-reply>` holds a copy of the replied-to message; the bridge resolves
    // replies structurally, so relaying the copy would duplicate the quote.
    let mut in_reply_block = 0usize;
    let mut in_pre = 0usize;
    // An open `<a>`: markdown needs the link text before the href, so the text
    // is buffered until the closing tag.
    let mut open_link: Option<(String, String)> = None;

    while let Some(lt) = rest.find('<') {
        let text = &rest[..lt];
        if in_reply_block == 0 {
            match &mut open_link {
                Some((_, buffer)) => buffer.push_str(&decode_entities(text)),
                None => out.push_str(&decode_entities(text)),
            }
        }
        rest = &rest[lt..];

        let Some(end) = rest.find('>') else {
            // A stray `<` that opens no tag: the rest is text.
            if in_reply_block == 0 && open_link.is_none() {
                out.push_str(&decode_entities(rest));
            }
            rest = "";
            break;
        };
        let tag = &rest[1..end];
        rest = &rest[end + 1..];

        let (closing, name, attrs) = parse_tag(tag);
        match name {
            "mx-reply" => {
                if closing {
                    in_reply_block = in_reply_block.saturating_sub(1);
                } else {
                    in_reply_block += 1;
                }
            }
            _ if in_reply_block > 0 => {}
            "strong" | "b" => out.push_str("**"),
            "em" | "i" => out.push('_'),
            "del" | "s" => out.push_str("~~"),
            "code" if in_pre > 0 => {}
            "code" => out.push('`'),
            "pre" => {
                if closing {
                    in_pre = in_pre.saturating_sub(1);
                    out.push_str("```\n");
                } else {
                    in_pre += 1;
                    out.push_str("```\n");
                }
            }
            "br" => out.push('\n'),
            "p" | "div" => {
                if closing && !out.ends_with("\n\n") {
                    out.push_str("\n\n");
                }
            }
            "a" => {
                if closing {
                    if let Some((href, text)) = open_link.take() {
                        let label = if text.is_empty() { href.clone() } else { text };
                        out.push('[');
                        out.push_str(&label);
                        out.push_str("](");
                        out.push_str(&href);
                        out.push(')');
                    }
                } else if let Some(href) = attr_value(attrs, "href") {
                    open_link = Some((href.to_string(), String::new()));
                }
            }
            _ => {}
        }
    }

    // Text after the final tag is still body text.
    if !rest.is_empty() && in_reply_block == 0 {
        match &mut open_link {
            Some((_, buffer)) => buffer.push_str(&decode_entities(rest)),
            None => out.push_str(&decode_entities(rest)),
        }
    }

    // An unterminated link still contributes its text.
    if let Some((href, text)) = open_link.take() {
        if text.is_empty() {
            out.push_str(&href);
        } else {
            out.push_str(&text);
        }
    }

    Some(out)
}

/// Decode the HTML entities Matrix clients emit.
fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// Split a tag into `(closing, name, attributes)`.
fn parse_tag(tag: &str) -> (bool, &str, &str) {
    let tag = tag.trim_end_matches('/');
    let (closing, rest) = match tag.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, tag),
    };
    match rest.find(char::is_whitespace) {
        Some(index) => (closing, &rest[..index], rest[index..].trim()),
        None => (closing, rest, ""),
    }
}

/// Read one attribute's value from a tag's attribute string.
fn attr_value<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=");
    let start = attrs.find(&needle)? + needle.len();
    let rest = &attrs[start..];
    let rest = rest.strip_prefix('"').or_else(|| rest.strip_prefix('\''))?;
    let quote = if attrs[start..].starts_with('"') {
        '"'
    } else {
        '\''
    };
    let end = rest.find(quote)?;
    Some(&rest[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedupe::{Dedupe, Mapping, MappingKind};

    fn portal() -> Portal {
        Portal {
            id: crate::ids::PortalId::new(
                crate::ids::SpaceDid::parse("did:plc:space").unwrap(),
                MatrixRoomId::parse("!room:example.org").unwrap(),
            ),
            roomy_room_id: RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: Some("Room".into()),
            encryption: crate::PortalEncryption::plain(),
            state: crate::PortalState::Syncing,
            created_at: 0,
        }
    }

    /// The accepted ops, failing the test on any rejection.
    fn ops(event: &IncomingEvent, dedupe: &Dedupe, edits: &mut EditOrder) -> Vec<Op> {
        match translate(event, &portal(), &ghost(), dedupe, edits) {
            Ok(decisions) => decisions.into_iter().map(|decision| decision.op).collect(),
            Err(reason) => panic!("unexpected rejection: {reason:?}"),
        }
    }

    fn ghost() -> GhostDid {
        GhostDid::parse("did:matrix:%40alice%3Aexample.org").unwrap()
    }

    fn message(event_id: &str, text: &str) -> IncomingEvent {
        IncomingEvent {
            event_id: MatrixEventId::parse(event_id).unwrap(),
            room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
            sender: GhostMxid::parse("@alice:example.org").unwrap(),
            origin_server_ts: 1_700_000_000_000,
            kind: IncomingKind::Message {
                body: Body::plain(text),
                media: vec![],
                reply_to: None,
                thread_root: None,
            },
            encrypted: false,
        }
    }

    #[test]
    fn a_plain_message_becomes_a_send_with_its_origin() {
        let dedupe = Dedupe::default();
        let mut edits = EditOrder::default();
        let ops = ops(&message("$msg", "hello"), &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::Send {
                body,
                timestamp,
                origin: Some(origin),
                ..
            }] => {
                assert_eq!(body, "hello");
                assert_eq!(*timestamp, 1_700_000_000_000);
                assert_eq!(origin.event_id.as_ref().unwrap().as_str(), "$msg");
            }
            other => panic!("expected one send, got {other:?}"),
        }
    }

    #[test]
    fn a_message_the_id_map_knows_is_not_relayed() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$msg".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();
        assert_eq!(
            translate(
                &message("$msg", "hello"),
                &portal(),
                &ghost(),
                &dedupe,
                &mut edits
            )
            .unwrap_err(),
            Rejection::Duplicate
        );
    }

    #[test]
    fn a_reply_attachment_is_emitted_only_for_a_bridged_target() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$root".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();
        let mut event = message("$reply", "yes");
        if let IncomingKind::Message { reply_to, .. } = &mut event.kind {
            *reply_to = Some(MatrixEventId::parse("$root").unwrap());
        }
        let ops = ops(&event, &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::Send { reply_to, .. }] => {
                assert_eq!(
                    reply_to.as_ref().map(RoomyEventId::as_str),
                    Some("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD")
                );
            }
            other => panic!("expected one send, got {other:?}"),
        }
    }

    #[test]
    fn an_unbridged_reply_target_is_not_referenced() {
        let dedupe = Dedupe::default();
        let mut edits = EditOrder::default();
        let mut event = message("$reply", "yes");
        if let IncomingKind::Message { reply_to, .. } = &mut event.kind {
            *reply_to = Some(MatrixEventId::parse("$unknown").unwrap());
        }
        let ops = ops(&event, &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::Send { reply_to, .. }] => assert_eq!(*reply_to, None),
            other => panic!("expected one send, got {other:?}"),
        }
    }

    #[test]
    fn an_older_edit_does_not_overwrite_a_newer_one() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$msg".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();

        let mut newer = message("$edit1", "second");
        newer.kind = IncomingKind::Edit {
            target: MatrixEventId::parse("$msg").unwrap(),
            body: Body::plain("second"),
        };
        newer.origin_server_ts = 2_000;
        assert_eq!(ops(&newer, &dedupe, &mut edits).len(), 1);

        let mut older = message("$edit2", "first");
        older.kind = IncomingKind::Edit {
            target: MatrixEventId::parse("$msg").unwrap(),
            body: Body::plain("first"),
        };
        older.origin_server_ts = 1_000;
        assert_eq!(
            translate(&older, &portal(), &ghost(), &dedupe, &mut edits).unwrap_err(),
            Rejection::Superseded
        );
    }

    #[test]
    fn an_edit_for_an_unknown_message_is_dropped() {
        let dedupe = Dedupe::default();
        let mut edits = EditOrder::default();
        let mut event = message("$edit", "x");
        event.kind = IncomingKind::Edit {
            target: MatrixEventId::parse("$unknown").unwrap(),
            body: Body::plain("x"),
        };
        assert_eq!(
            translate(&event, &portal(), &ghost(), &dedupe, &mut edits).unwrap_err(),
            Rejection::NotBridged
        );
    }

    #[test]
    fn redacting_a_reaction_removes_the_reaction() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Reaction,
            matrix_id: "$reaction".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();
        let mut event = message("$redact", "");
        event.kind = IncomingKind::Redaction {
            target: MatrixEventId::parse("$reaction").unwrap(),
            reason: None,
        };
        let ops = ops(&event, &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::Unreact { reaction_id, .. }] => {
                assert_eq!(reaction_id.as_str(), "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF");
            }
            other => panic!("expected an unreact, got {other:?}"),
        }
    }

    #[test]
    fn redacting_a_message_deletes_it() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$msg".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();
        let mut event = message("$redact", "");
        event.kind = IncomingKind::Redaction {
            target: MatrixEventId::parse("$msg").unwrap(),
            reason: Some("spam".into()),
        };
        let ops = ops(&event, &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::Redact { target, reason, .. }] => {
                assert_eq!(target.as_str(), "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD");
                assert_eq!(reason.as_deref(), Some("spam"));
            }
            other => panic!("expected a redact, got {other:?}"),
        }
    }

    #[test]
    fn a_reaction_becomes_a_bridged_reaction() {
        let mut dedupe = Dedupe::default();
        dedupe.record(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$msg".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        let mut edits = EditOrder::default();
        let mut event = message("$reaction", "");
        event.kind = IncomingKind::Reaction {
            target: MatrixEventId::parse("$msg").unwrap(),
            key: "🎉".into(),
        };
        let ops = ops(&event, &dedupe, &mut edits);
        match ops.as_slice() {
            [Op::React { emoji, author, .. }] => {
                assert_eq!(emoji, "🎉");
                assert_eq!(author.as_str(), "did:matrix:%40alice%3Aexample.org");
            }
            other => panic!("expected a react, got {other:?}"),
        }
    }

    #[test]
    fn html_is_converted_to_markdown() {
        let body = Body {
            text: "bold and italic".into(),
            formatted: Some(FormattedBody {
                format: "org.matrix.custom.html".into(),
                body: "<strong>bold</strong> and <em>italic</em>".into(),
            }),
        };
        assert_eq!(markdown_body(&body), "**bold** and _italic_");
    }

    #[test]
    fn the_quoted_copy_of_a_reply_block_is_dropped() {
        let body = Body {
            text: "yes".into(),
            formatted: Some(FormattedBody {
                format: "org.matrix.custom.html".into(),
                body: "<mx-reply><blockquote>original</blockquote></mx-reply>yes".into(),
            }),
        };
        assert_eq!(markdown_body(&body), "yes");
    }

    #[test]
    fn an_unformatted_body_passes_through_verbatim() {
        let body = Body::plain("<not html> *literally*");
        assert_eq!(markdown_body(&body), "<not html> *literally*");
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt;"), "a & b <c>");
    }
}
