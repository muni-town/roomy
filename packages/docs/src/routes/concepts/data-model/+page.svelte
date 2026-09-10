<svelte:head>
  <title>Database Schema — Roomy Appserver API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Database Schema</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    The appserver runs three SQLite databases: the raw event log, the materialised views (bun:sqlite), and appserver-owned read state. Materialisation is deterministic from the event log, so a schema-version bump wipes the view DB and re-materialises from scratch.
  </p>

  <hr />

  <h2>Event Log (events.stream_events)</h2>

  <p>The source of truth. One row per event per stream; rows are never deleted or modified. The <code>StreamManager</code> appends events (CBOR payloads) with sequential <code>idx</code> values in a single transaction, materialises the batch inline, and the startup <code>reMaterializeFromLocalEvents</code> replays any gap (tracked by <code>materialization_cursor</code>).</p>

  <pre><code>create table stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    event_type text,          -- denormalized $type for dashboard stats
    created_at integer,       -- epoch ms, set at insert time
    primary key (stream_id, idx)
) strict;

create table stream_state (
    stream_id text primary key,
    latest_event integer not null default 0
) strict;

-- Per-stream DID signing keys (k256), for PLC operations.
create table dids ( did text primary key ) strict;
create table did_keys ( did text references dids(did), p256_key blob, k256_key blob, unique (did) ) strict;
create table did_owners ( did text references dids(did), owner text not null, unique (did, owner) ) strict;</code></pre>

  <h2>Materialised Views (schema.sql)</h2>

  <p>Ported from the legacy frontend worker schema so the SDK's pure materializer functions are reused unchanged; the column names and types must stay in sync with the SDK. <code>SCHEMA_VERSION</code> bumps wipe this DB and trigger a full re-materialisation from the event log.</p>

  <h3>entities</h3>
  <p>The base table for all entities (spaces, rooms, messages, users). Every entity has a unique ID (DID or ULID) and belongs to a stream.</p>
  <pre><code>create table entities (
  id text primary key,          -- did or ulid
  stream_id text not null,      -- did
  room text,                    -- ulid, references room id
  sort_idx text,                -- mutable timeline ordering index
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h3>edges</h3>
  <p>Directed, labelled edges between entities. Used for membership (<code>joinedSpace</code> / <code>leftSpace</code> from the user DID), admin status (<code>admin</code>), room linking (<code>link</code>, with <code>canonical_parent</code> for threads), forwarding, and more.</p>
  <pre><code>create table edges (
  head text not null,
  tail text not null,
  label text not null,
  payload text,
  created_at integer not null,
  updated_at integer not null,
  primary key (head, tail, label)
);</code></pre>

  <h3>comp_space</h3>
  <p>Space-global config, handle, backfill cursor, and join policy. One row per space. Membership is <strong>not</strong> read from this row — it lives in <code>edges</code> as per-user <code>joinedSpace</code> rows (the legacy <code>hidden</code> column is written for compatibility but ignored by the appserver).</p>
  <pre><code>create table comp_space (
  entity text primary key,
  hidden integer default 0,
  handle text,
  handle_provider text,
  backfilled_to integer default 0,
  sidebar_config text not null default '&#123;"categories": []&#125;',
  allow_public_join integer,
  allow_member_invites integer,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h3>comp_room</h3>
  <p>Room metadata: label (channel/thread/page), default_access, and soft-delete flag.</p>
  <pre><code>create table comp_room (
  entity text primary key,
  label text,                   -- "space.roomy.channel", "space.roomy.thread", etc.
  default_access text check(default_access in ('readwrite', 'read', 'none')) default 'readwrite',
  deleted integer default 0,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h3>comp_info</h3>
  <p>Display info (name, avatar, description, banner, pronouns, website) for any entity. Banner, pronouns, and website are populated from the Roomy profile record (<code>space.roomy.user.profile</code>).</p>
  <pre><code>create table comp_info (
  entity text primary key,
  name text,
  avatar text,
  description text,
  banner text,
  pronouns text,
  website text,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h3>comp_content</h3>
  <p>Message content: raw data blob with MIME type and canonical timestamp.</p>
  <pre><code>create table comp_content (
  entity text primary key,
  mime_type text,
  data blob,
  last_edit text not null,
  timestamp integer,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h3>comp_user</h3>
  <p>User records: DID to handle mapping.</p>
  <pre><code>create table comp_user (
  did text primary key,
  handle text,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h2>Read State (readStateSchema.sql)</h2>

  <p>Appserver-owned state that <strong>cannot</strong> be reconstructed from the event log. Lives in its own database so it survives materialisation schema changes.</p>

  <h3>read_positions</h3>
  <p>Per-user, per-room read positions. The appserver is the source of truth for read state; <code>seen_up_to</code> is the sort_idx of the last-read message entity.</p>
  <pre><code>create table read_positions (
  user_did    text not null,
  room_id     text not null,
  seen_up_to  text not null,
  unread_count integer not null default 0,
  updated_at  integer not null,
  primary key (user_did, room_id)
);</code></pre>

  <h3>user_thread_activity</h3>
  <p>Per-user last-active timestamps for threads, driving the "active threads" sidebar section.</p>
  <pre><code>create table user_thread_activity (
  user_did      text not null,
  thread_id     text not null,
  last_active_at integer not null,   -- epoch ms
  updated_at    integer not null,
  primary key (user_did, thread_id)
);</code></pre>

  <h3>push_subscriptions / push_user_default / push_preferences</h3>
  <p>Web Push state: browser subscriptions (idempotent on endpoint), a user-wide default notification level, and per-space overrides. Levels: <code>silent</code>, <code>quiet</code>, <code>engaged</code> (default), <code>busy</code>.</p>

  <h3>user_room_participation / notification_state</h3>
  <p>Per-room participation timestamps and engaged-digest batching (first-unseen timestamps, reset by <code>updateSeen</code>).</p>

  <h3>feature_flags / feature_flag_assignments</h3>
  <p>Feature flag definitions and per-user assignments. A flag is enabled for a user when set globally or assigned to their DID.</p>

  <h2>Roles and Permissions</h2>

  <h3>roles</h3>
  <p>Role definitions within a space.</p>
  <pre><code>create table roles (
  id text primary key,
  stream_id text not null,
  name text,
  avatar text,
  description text,
  deleted integer not null default 0
);</code></pre>

  <h3>member_roles</h3>
  <p>Many-to-many mapping of users to roles within a space.</p>
  <pre><code>create table member_roles (
  user_id text not null,
  role_id text not null,
  stream_id text not null,
  primary key (user_id, role_id)
);</code></pre>

  <h3>role_rooms</h3>
  <p>Per-room permissions granted by a role. For threads, permissions attach to the parent channel.</p>
  <pre><code>create table role_rooms (
  role_id text not null,
  room_id text not null,
  stream_id text not null,
  permission text not null check(permission in ('read', 'readwrite')),
  primary key (role_id, room_id)
);</code></pre>

  <h2>Embed Tables</h2>

  <p>Rich media embeds attached to messages:</p>
  <ul>
    <li><strong>comp_embed_image</strong> — Image embeds with dimensions, blurhash, alt text</li>
    <li><strong>comp_embed_video</strong> — Video embeds with dimensions, length, blurhash</li>
    <li><strong>comp_embed_file</strong> — File attachments with name and size</li>
    <li><strong>comp_embed_link</strong> — Link embeds with preview toggle</li>
    <li><strong>comp_embed_link_data</strong> — Cached enriched embed data (title, description, image) fetched asynchronously by the embed sweeper; transient failures retry with exponential backoff (<code>attempts</code>, <code>retry_after</code>)</li>
  </ul>

  <h2>Activity Feed</h2>

  <h3>activity_item</h3>
  <p>Materialised activity feed items. One row per room that has seen at least one message. Upserted on every createMessage event; <code>recent_message_ids</code> is a JSON array of the 5 most recent message ULIDs (newest first) so the read path batch-queries message data.</p>
  <pre><code>create table activity_item (
  room_id text primary key,
  space_id text not null,
  is_thread integer not null default 0,
  parent_channel_id text,
  parent_channel_name text,
  last_activity_at integer not null,
  recent_message_ids text not null default '[]',
  room_name text,
  space_name text,
  space_avatar text,
  created_at integer not null,
  updated_at integer not null
);</code></pre>

  <h2>Other Tables</h2>

  <ul>
    <li><strong>comp_bans</strong> — Banned users per space (explicit deny, even for admins)</li>
    <li><strong>comp_invite</strong> — Active invite tokens per space (appserver-only; the worker swallowed errors here)</li>
    <li><strong>comp_discord_origin</strong> — Discord bridge origin tracking</li>
    <li><strong>comp_page_edits</strong> — Page edit history (one row per edit)</li>
    <li><strong>comp_comment</strong> — Page comments</li>
    <li><strong>comp_reaction</strong> — Message reactions (emoji per user per message)</li>
    <li><strong>comp_calendar_link / comp_calendar_event</strong> — OpenMeet calendar integration</li>
    <li><strong>comp_last_read</strong> — Legacy per-room read position (superseded by <code>read_positions</code>)</li>
    <li><strong>materialization_cursor</strong> — Per-stream materialization cursor, read on boot to skip caught-up streams</li>
    <li><strong>roomy_schema_version</strong> — Materialised-view schema version; a bump wipes and re-materialises</li>
  </ul>

  <h2>Key Indexes</h2>

  <ul>
    <li><code>idx_entities_stream_id</code> / <code>idx_entities_stream_room</code> — Filter entities by stream / stream+room</li>
    <li><code>idx_entities_sort_idx</code> — Timeline ordering</li>
    <li><code>idx_entities_room</code> — Room-scoped lookups (latest entity in a thread)</li>
    <li><code>idx_entities_room_sort</code> — Room-scoped sort_idx lookups (unread counts, watermarks)</li>
    <li><code>idx_edges_label</code> / <code>idx_edges_label_head</code> / <code>idx_edges_label_tail</code> — Edge label lookups</li>
    <li><code>idx_comp_room_label</code> — Room type filtering</li>
    <li><code>idx_activity_item_global</code> / <code>idx_activity_item_space</code> — Activity feed ordering</li>
    <li><code>idx_member_roles_role_id</code> / <code>idx_role_rooms_room_id</code> — Role grant lookups</li>
  </ul>
</div>
