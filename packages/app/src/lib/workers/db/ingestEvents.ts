import type { CompPage } from "$lib/db/types/components";
import type { EdgeLabel } from "$lib/db/types/edges";
import type { EntityId, EntityLabel } from "$lib/db/types/entities";
import type {
  AnyEvent,
  ComponentData,
  DomainEvent,
  DomainEventMap,
  EdgePayload,
  MessageDeleteEvent,
  MessageEditEvent,
  MessagePostEvent,
  MessageReactEvent,
  MessageReorderEvent,
  MessageUnreactEvent,
  PageCreateEvent,
  SpaceAddMemberEvent,
  SpaceBanUserEvent,
  SpaceCreateEvent,
  SpaceRemoveMemberEvent,
  ThreadCreateEvent,
  ThreadMarkReadEvent,
  ThreadPinMessageEvent,
  UploadCompleteEvent,
  UploadFailEvent,
  UploadStartEvent,
  UserCreateEvent,
  UserSubscribeThreadEvent,
} from "../lib/db/types/events";
import { executeQuery } from "./setup-sqlite";

function encodeJsonToBlob(data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(json);
}

function ulidToBytes(ulid: string): Uint8Array {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const map: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i++) {
    const ch = alphabet.charAt(i);
    map[ch] = i;
    map[ch.toLowerCase()] = i;
  }
  const out = new Uint8Array(16);
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (let i = 0; i < ulid.length && idx < 16; i++) {
    const c = ulid.charAt(i);
    const v = map[c];
    if (v === undefined) continue;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
      value = value & ((1 << bits) - 1);
    }
  }
  if (idx === 16) return out;
  // Fallback to ASCII bytes if decoding failed
  return new TextEncoder().encode(ulid);
}

type PreparedRow = [
  eventId: Uint8Array,
  entityIdOrNull: null | Uint8Array,
  payload: Uint8Array,
  createdAtMs: number,
];

function prepareRow(e: AnyEvent): PreparedRow {
  const eventId = ulidToBytes((e as { eventId: string }).eventId);
  const entityId: string | undefined = (e as { entityId?: string }).entityId;
  const entityBlob = entityId ? ulidToBytes(entityId) : null;
  const payload = encodeJsonToBlob(e);
  const createdAt = (e as { createdAt?: number }).createdAt ?? Date.now();
  return [eventId, entityBlob, payload, createdAt];
}

function buildInsert(rows: number): { sql: string; bind: unknown[] } {
  const values = new Array(rows).fill("(?, ?, ?, ?)").join(", ");
  const sql = `BEGIN IMMEDIATE; INSERT INTO events (event_ulid, entity_ulid, payload, created_at) VALUES ${values}; COMMIT;`;
  return { sql, bind: [] };
}

export async function ingestEvents(
  events: AnyEvent | AnyEvent[],
): Promise<{ ok: true; inserted: number }> {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return { ok: true, inserted: 0 };

  const rows = list.map(prepareRow);
  const { sql } = buildInsert(rows.length);
  const bind: unknown[] = [];
  for (const [eventId, entityIdOrNull, payload, createdAtMs] of rows) {
    bind.push(eventId, entityIdOrNull, payload, createdAtMs);
  }
  await executeQuery(sql, bind);
  return { ok: true, inserted: rows.length };
}

function applyEvent<T extends keyof DomainEventMap>(
  e: DomainEventMap[T],
): { sql: string; bind: unknown[] }[] {
  switch (e.type) {
    case "user.create":
      return applyUserCreate(e);
    case "user.subscribe_thread":
      return applyUserSubscribeThread(e);
    case "space.create":
      return applySpaceCreate(e);
    case "space.add_member":
      return applySpaceAddMember(e);
    case "space.remove_member":
      return applySpaceRemoveMember(e);
    case "space.ban_user":
      return applySpaceBanUser(e);
    case "thread.create":
      return applyThreadCreate(e);
    case "thread.pin_message":
      return applyThreadPinMessage(e);
    case "page.create":
      return applyPageCreate(e);
    case "thread.mark_read":
      return applyThreadMarkRead(e);
    case "message.post":
      return applyMessagePost(e);
    case "message.edit":
      return applyMessageEdit(e);
    case "message.delete":
      return applyMessageDelete(e);
    case "message.react":
      return applyMessageReact(e);
    case "message.unreact":
      return applyMessageUnreact(e);
    case "message.reorder":
      return applyMessageReorder(e);
    case "upload.start":
      return applyUploadStart(e);
    case "upload.complete":
      return applyUploadComplete(e);
    case "upload.fail":
      return applyUploadFail(e);
    default:
      throw new Error(`Unknown event type: ${JSON.stringify(e)}`);
  }
}

function checkApplied(e: DomainEvent) {
  return {
    sql: `
    SELECT 1 FROM events WHERE event_ulid = ? AND applied = 1
    `,
    bind: [e.eventId],
  };
}

function markApplied(e: DomainEvent, entityId?: EntityId) {
  if (!entityId) {
    return {
      sql: `
      UPDATE events SET applied = 1 WHERE event_ulid = ?
    `,
      bind: [e.eventId],
    };
  }
  return {
    sql: `
    UPDATE events SET (applied, entity_ulid) = (1, ?) WHERE event_ulid = ?
  `,
    bind: [entityId, e.eventId],
  };
}

function checkEntity(id: EntityId, label: EntityLabel) {
  return {
    sql: `
    SELECT 1 FROM entities WHERE id = ? AND label = ?
    `,
    bind: [id, label],
  };
}

function ensureEntity(e: DomainEvent, id: EntityId, label: EntityLabel) {
  return {
    sql: `
    INSERT INTO entities (id, label, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `,
    bind: [id, label, e.createdAt],
  };
}

function ensureEntityDeleted(id: EntityId, label: EntityLabel) {
  return {
    sql: `
    DELETE FROM entities WHERE id = ? AND label = ?
  `,
    bind: [id, label],
  };
}

function addEdge(
  e: DomainEvent,
  head: EntityId,
  tail: EntityId,
  label: EdgeLabel,
) {
  return {
    sql: `
    INSERT INTO edges (head, tail, label, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(head, tail, label) DO NOTHING
  `,
    bind: [head, tail, label, e.createdAt],
  };
}

function upsertEdgeWithPayload(
  e: DomainEvent,
  head: EntityId,
  tail: EntityId,
  label: EdgeLabel,
  payload: EdgePayload<EdgeLabel>,
) {
  return {
    sql: `
    INSERT INTO edges (entity_id, target_entity_id, label, created_at, payload) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, target_entity_id, label) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload
  `,
    bind: [head, tail, label, e.createdAt, payload],
  };
}

function removeEdge(head: EntityId, tail: EntityId, label: EdgeLabel) {
  return {
    sql: `
    DELETE FROM edges WHERE head = ? AND tail = ? AND label = ?
  `,
    bind: [head, tail, label],
  };
}

function upsertComponentProfile(
  e: DomainEvent,
  data: ComponentData<"profile">,
) {
  return {
    sql: `
    INSERT INTO comp_profile (entity_id, created_at, updated_at, bluesky_handle, banner_url, joined_date) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, bluesky_handle = excluded.bluesky_handle, banner_url = excluded.banner_url, joined_date = excluded.joined_date
  `,
    bind: [e.eventId, data.blueskyHandle, data.bannerUrl, data.joinedDate],
  };
}

function upsertComponentConfig(e: DomainEvent, data: ComponentData<"config">) {
  return {
    sql: `
    INSERT INTO comp_config (entity_id, created_at, updated_at, config) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, config = excluded.config
  `,
    bind: [e.eventId, data.config],
  };
}

function upsertComponentPage(e: DomainEvent) {
  return {
    sql: `
    INSERT INTO comp_page (entity_id, created_at, updated_at) VALUES (?, unixepoch() * 1000, unixepoch() * 1000)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000
  `,
    bind: [e.eventId],
  };
}

function upsertComponentUpload(e: DomainEvent, data: ComponentData<"upload">) {
  return {
    sql: `
    INSERT INTO comp_upload (entity_id, created_at, updated_at, type, status, url) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, type = excluded.type, status = excluded.status, url = excluded.url
  `,
    bind: [e.eventId, data.media_type, data.status, data.url],
  };
}

function upsertComponentUserAccessTimes(
  e: DomainEvent,
  data: ComponentData<"user_access_times">,
) {
  return {
    sql: `
    INSERT INTO comp_user_access_times (entity_id, created_at, updated_at, user_created_at, user_updated_at) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, user_created_at = excluded.user_created_at, user_updated_at = excluded.user_updated_at
  `,
    bind: [e.eventId, data.user_created_at, data.user_updated_at],
  };
}

function upsertComponentTextContent(
  e: DomainEvent,
  data: ComponentData<"text_content">,
) {
  return {
    sql: `
    INSERT INTO comp_text_content (entity_id, created_at, updated_at, text, format) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, text = excluded.text, format = excluded.format
  `,
    bind: [e.eventId, data.text, data.format],
  };
}

function upsertComponentName(e: DomainEvent, data: ComponentData<"name">) {
  return {
    sql: `
    INSERT INTO comp_name (entity_id, created_at, updated_at, name) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, name = excluded.name
  `,
    bind: [e.eventId, data.name],
  };
}

function upsertComponentMedia(e: DomainEvent, data: ComponentData<"media">) {
  return {
    sql: `
    INSERT INTO comp_media (entity_id, created_at, updated_at, mime_type, width, height, uri) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, mime_type = excluded.mime_type, width = excluded.width, height = excluded.height, uri = excluded.uri
  `,
    bind: [e.eventId, data.mime_type, data.width, data.height, data.uri],
  };
}

function upsertComponentIdentifier(
  e: DomainEvent,
  data: ComponentData<"identifier">,
) {
  return {
    sql: `
    INSERT INTO comp_identifier (entity_id, created_at, updated_at, public_key) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, public_key = excluded.public_key
  `,
    bind: [e.eventId, data.public_key],
  };
}

function upsertComponentDescription(
  e: DomainEvent,
  data: ComponentData<"description">,
) {
  return {
    sql: `
    INSERT INTO comp_description (entity_id, created_at, updated_at, description) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, description = excluded.description
  `,
    bind: [e.eventId, data.description],
  };
}

function upsertComponentUrl(e: DomainEvent, data: ComponentData<"url">) {
  return {
    sql: `
    INSERT INTO comp_url (entity_id, created_at, updated_at, url) VALUES (?, unixepoch() * 1000, unixepoch() * 1000, ?)
    ON CONFLICT(entity_id) DO UPDATE SET created_at = excluded.created_at, updated_at = unixepoch() * 1000, url = excluded.url
  `,
    bind: [e.eventId, data.url],
  };
}

function applyUserCreate(e: UserCreateEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.userId, "user"),
  ];
  if (e.name?.name) {
    statements.push(upsertComponentName(e, e.name));
  }
  if (e.description?.description) {
    statements.push(upsertComponentDescription(e, e.description));
  }
  if (e.profile) {
    statements.push(upsertComponentProfile(e, e.profile));
  }
  if (e.config) {
    statements.push(upsertComponentConfig(e, e.config));
  }
  if (e.avatarImageId) {
    statements.push(addEdge(e, e.userId, e.avatarImageId, "avatar"));
  }
  statements.push(markApplied(e, e.userId));
  return statements;
}

function applyUserSubscribeThread(e: UserSubscribeThreadEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    checkEntity(e.threadId, "timeline"),
    ensureEntity(e, e.userId, "user"),
    addEdge(e, e.userId, e.threadId, "subscribe"),
    markApplied(e, e.userId),
  ];
  return statements;
}

function applySpaceCreate(e: SpaceCreateEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.spaceId, "space"),
  ];
  if (e.name?.name) {
    statements.push(upsertComponentName(e, e.name));
  }
  if (e.description?.description) {
    statements.push(upsertComponentDescription(e, e.description));
  }
  if (e.avatarImageId) {
    statements.push(checkEntity(e.avatarImageId, "media"));
    statements.push(addEdge(e, e.spaceId, e.avatarImageId, "avatar"));
  }
  statements.push(markApplied(e, e.spaceId));
  return statements;
}

function applySpaceAddMember(e: SpaceAddMemberEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    checkEntity(e.spaceId, "space"),
    checkEntity(e.userId, "user"),
    upsertEdgeWithPayload(e, e.spaceId, e.userId, "member", e.member),
    markApplied(e, e.spaceId),
  ];
  return statements;
}

function applySpaceRemoveMember(e: SpaceRemoveMemberEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    checkEntity(e.spaceId, "space"),
    checkEntity(e.userId, "user"),
    removeEdge(e.spaceId, e.userId, "member"),
    markApplied(e, e.spaceId),
  ];
  return statements;
}

function applySpaceBanUser(e: SpaceBanUserEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    checkEntity(e.spaceId, "space"),
    checkEntity(e.userId, "user"),
    upsertEdgeWithPayload(e, e.spaceId, e.userId, "ban", {
      reason: e.reason ?? "",
      banned_by: e.bannedBy ?? "",
    }),
    markApplied(e, e.spaceId),
  ];
  return statements;
}

function applyThreadCreate(e: ThreadCreateEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.threadId, "timeline"),
  ];
  if (e.spaceId) {
    statements.push(checkEntity(e.spaceId, "space"));
    statements.push(addEdge(e, e.spaceId, e.threadId, "child"));
    statements.push(addEdge(e, e.threadId, e.spaceId, "parent"));
  }
  if (e.name?.name) {
    statements.push(upsertComponentName(e, e.name));
  }
  if (e.description?.description) {
    statements.push(upsertComponentDescription(e, e.description));
  }
  statements.push(markApplied(e, e.threadId));
  return statements;
}

function applyThreadPinMessage(e: ThreadPinMessageEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.threadId, "timeline"),
    ensureEntity(e, e.messageId, "message"),
    addEdge(e, e.threadId, e.messageId, "pin"),
    markApplied(e, e.threadId),
  ];
  return statements;
}

function applyPageCreate(e: PageCreateEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.pageId, "timeline"),
    upsertComponentPage(e),
  ];
  if (e.name?.name) {
    statements.push(upsertComponentName(e, e.name));
  }
  if (e.description?.description) {
    statements.push(upsertComponentDescription(e, e.description));
  }
  statements.push(markApplied(e, e.pageId));
  return statements;
}

function applyThreadMarkRead(e: ThreadMarkReadEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.userId, "user"),
    ensureEntity(e, e.threadId, "timeline"),
    addEdge(e, e.userId, e.threadId, "last_read"),
    markApplied(e, e.userId),
  ];
  return statements;
}

function applyMessagePost(e: MessagePostEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.messageId, "message"),
    addEdge(e, e.threadId, e.messageId, "child"),
    addEdge(e, e.messageId, e.threadId, "parent"),
    markApplied(e, e.messageId),
  ];
  if (e.text?.text) {
    statements.push(upsertComponentTextContent(e, e.text));
  }
  if (e.replyToMessageId) {
    statements.push(addEdge(e, e.messageId, e.replyToMessageId, "reply"));
  }
  if (e.embeds) {
    for (const embed of e.embeds) {
      statements.push(addEdge(e, e.messageId, embed, "embed"));
    }
  }
  statements.push(markApplied(e, e.messageId));
  return statements;
}

function applyMessageEdit(e: MessageEditEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    checkEntity(e.messageId, "message"),
  ];
  if (e.text?.text) {
    statements.push(upsertComponentTextContent(e, e.text));
  }
  statements.push(markApplied(e, e.messageId));
  return statements;
}

function applyMessageDelete(e: MessageDeleteEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntityDeleted(e.messageId, "message"), // edges will be deleted on cascade
    markApplied(e, e.messageId),
  ];
  return statements;
}

function applyMessageReact(e: MessageReactEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.userId, "user"),
    ensureEntity(e, e.messageId, "message"),
    upsertEdgeWithPayload(e, e.userId, e.messageId, "reaction", {
      reaction: e.reaction,
    }),
    markApplied(e, e.userId),
  ];
  return statements;
}

function applyMessageUnreact(e: MessageUnreactEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    removeEdge(e.userId, e.messageId, "reaction"),
    markApplied(e, e.userId),
  ];
  return statements;
}

function applyMessageReorder(e: MessageReorderEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    addEdge(e, e.messageId, e.afterMessageId, "reorder"),
    markApplied(e, e.messageId),
  ];
  return statements;
}

function applyUploadStart(e: UploadStartEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.uploadId, "task"),
    upsertComponentUpload(e, {
      media_type: e.mediaType,
      status: "pending",
      url: null,
    }),
  ];
  if (e.attachToMessageId) {
    statements.push(addEdge(e, e.uploadId, e.attachToMessageId, "link"));
  }
  statements.push(markApplied(e, e.uploadId));
  return statements;
}

function applyUploadComplete(e: UploadCompleteEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.uploadId, "task"),
    upsertComponentUpload(e, {
      media_type: e.mediaType,
      status: "completed",
      url: e.url,
    }),
    markApplied(e, e.uploadId),
  ];
  return statements;
}

function applyUploadFail(e: UploadFailEvent) {
  const statements: { sql: string; bind: unknown[] }[] = [
    checkApplied(e),
    ensureEntity(e, e.uploadId, "task"),
    upsertComponentUpload(e, {
      media_type: e.mediaType,
      status: "failed",
      url: null,
    }),
    markApplied(e, e.uploadId),
  ];
  return statements;
}