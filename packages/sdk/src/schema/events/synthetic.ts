/**
 * Synthetic events are query results that are materialized like events
 * but don't come from the event stream. They're used for efficient
 * bulk data fetching (e.g., space metadata) where we'd otherwise need
 * to materializing many individual events.
 *
 * Synthetic events are NOT stored in the events table - they're a
 * caching mechanism, not a source of truth.
 */

import { SqlStatement } from "../../types";
import { sql } from "../../utils";
import { StreamIndex, type } from "../primitives";
import { defineEvent } from "./utils";

/**
 * Synthetic event: space metadata bundle
 *
 * This is the result of the `space_meta` query from the Leaf module.
 * It contains all the space metadata that would normally require
 * materializing many individual events (space info, sidebar config,
 * channels, admins, calendar config).
 */

// Define sub-types first
const SpaceInfoType = type({
  name: "string | null",
  avatar: "string | null",
  description: "string | null",
  handleProvider: "string | null",
});

const SidebarType = type({
  categories: "unknown", // JSON array
});

const ChannelType = type({
  id: "string",
  name: "string | null",
  description: "string | null",
  avatar: "string | null",
});

const OpenMeetConfigType = type({
  groupSlug: "string | null",
  tenantId: "string | null",
  apiUrl: "string | null",
});

const SpaceMetaSyntheticSchema = type({
  $type: "'space.roomy.query.spaceMeta.v0'",
  latestIdx: type.or(StreamIndex, "null"),
  info: type.or(SpaceInfoType, "null"),
  sidebar: type.or(SidebarType, "null"),
  channels: type.or(ChannelType.array(), "null"),
  admins: type.or(type.string.array(), "null"),
  openmeetConfig: type.or(OpenMeetConfigType, "null"),
}).describe(
  "Synthetic event containing space metadata from the space_meta query",
);

export const SpaceMetaSynthetic = defineEvent(
  SpaceMetaSyntheticSchema,
  ({ streamId, event }) => {
    // Get the inferred type with proper typing
    // Use unknown to bypass the type mismatch since this is a synthetic event
    const data = event as unknown as typeof SpaceMetaSyntheticSchema.infer;
    const statements: SqlStatement[] = [];
    const timestamp = Date.now();

    // Ensure space entity exists
    statements.push(sql`
      insert into entities (id, stream_id, created_at, updated_at)
      values (${streamId}, ${streamId}, ${timestamp}, ${timestamp})
      on conflict(id) do update set
        updated_at = excluded.updated_at
    `);

    // Update backfilled_to if latestIdx is provided
    if (data.latestIdx !== null && data.latestIdx !== undefined) {
      statements.push(sql`
        insert into comp_space (entity, backfilled_to, created_at, updated_at)
        values (${streamId}, ${data.latestIdx}, ${timestamp}, ${timestamp})
        on conflict(entity) do update set
          backfilled_to = excluded.backfilled_to,
          updated_at = excluded.updated_at
      `);
    }

    // Space info (comp_info table)
    if (data.info !== null) {
      statements.push(sql`
        insert into comp_info (entity, name, avatar, description, created_at, updated_at)
        values (${streamId}, ${data.info.name}, ${data.info.avatar}, ${data.info.description}, ${timestamp}, ${timestamp})
        on conflict(entity) do update set
          name = coalesce(excluded.name, comp_info.name),
          avatar = coalesce(excluded.avatar, comp_info.avatar),
          description = coalesce(excluded.description, comp_info.description),
          updated_at = excluded.updated_at
      `);

      // Handle provider (comp_space table)
      if (data.info.handleProvider !== null) {
        statements.push(sql`
          insert into comp_space (entity, handle_provider, created_at, updated_at)
          values (${streamId}, ${data.info.handleProvider}, ${timestamp}, ${timestamp})
          on conflict(entity) do update set
            handle_provider = excluded.handle_provider,
            updated_at = excluded.updated_at
        `);
      }
    }

    // Sidebar config (comp_space table)
    if (data.sidebar !== null) {
      const sidebarJson = JSON.stringify(data.sidebar);
      statements.push(sql`
        insert into comp_space (entity, sidebar_config, updated_at)
        values (${streamId}, ${sidebarJson}, ${timestamp})
        on conflict(entity) do update set
          sidebar_config = excluded.sidebar_config,
          updated_at = excluded.updated_at
      `);
    }

    // Channels
    if (data.channels !== null) {
      for (const channel of data.channels) {
        // Ensure channel entity exists
        statements.push(sql`
          insert into entities (id, stream_id, room, created_at, updated_at)
          values (${channel.id}, ${streamId}, ${streamId}, ${timestamp}, ${timestamp})
          on conflict(id) do update set
            room = coalesce(excluded.room, entities.room),
            updated_at = excluded.updated_at
        `);

        // Room label
        statements.push(sql`
          insert into comp_room (entity, label, created_at, updated_at)
          values (${channel.id}, 'space.roomy.channel', ${timestamp}, ${timestamp})
          on conflict(entity) do update set
            label = excluded.label,
            updated_at = excluded.updated_at
        `);

        // Channel info (optional)
        if (channel.name || channel.avatar || channel.description) {
          statements.push(sql`
            insert into comp_info (entity, name, avatar, description, created_at, updated_at)
            values (${channel.id}, ${channel.name}, ${channel.avatar}, ${channel.description}, ${timestamp}, ${timestamp})
            on conflict(entity) do update set
              name = coalesce(excluded.name, comp_info.name),
              avatar = coalesce(excluded.avatar, comp_info.avatar),
              description = coalesce(excluded.description, comp_info.description),
              updated_at = excluded.updated_at
          `);
        }
      }
    }

    // Admins (member edges with admin permission)
    if (data.admins !== null) {
      for (const adminDid of data.admins) {
        statements.push(sql`
          insert into edges (head, tail, label, payload, created_at, updated_at)
          values (
            ${adminDid},
            ${streamId},
            'member',
            ${JSON.stringify({ can: "admin" })},
            ${timestamp},
            ${timestamp}
          )
          on conflict(head, tail, label) do update set
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `);
      }
    }

    // OpenMeet calendar config
    if (
      data.openmeetConfig !== null &&
      data.openmeetConfig.groupSlug !== null
    ) {
      statements.push(sql`
        insert or replace into comp_calendar_link (entity, group_slug, tenant_id, api_url)
        values (
          ${streamId},
          ${data.openmeetConfig.groupSlug},
          ${data.openmeetConfig.tenantId},
          ${data.openmeetConfig.apiUrl}
        )
      `);
    }

    return statements;
  },
);

// Synthetic event registry
export const syntheticEventRegistry = {
  "space.roomy.query.spaceMeta.v0": SpaceMetaSynthetic,
} as const;

export type SyntheticEventType = keyof typeof syntheticEventRegistry;

// Union type of all synthetic events
export type SyntheticEvent = typeof SpaceMetaSyntheticSchema.infer;

/**
 * Get the materializer for a synthetic event type
 */
export function getSyntheticMaterializer<T extends SyntheticEventType>(
  eventType: T,
) {
  return syntheticEventRegistry[eventType];
}
