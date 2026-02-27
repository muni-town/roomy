/**
 * Calendar integration events: OpenMeet group linking
 *
 * Setting groupSlug to null removes the calendar link (disconnect).
 * The materializer explicitly handles this as a deletion.
 */

import { SqlStatement } from "../../types";
import { sql } from "../../utils";
import { type } from "../primitives";
import { defineEvent } from "./utils";

const SetCalendarLinkSchema = type({
  $type: "'space.roomy.openmeet.configure.v0'",
  groupSlug: "string | null",
  tenantId: "string | null",
  apiUrl: "string | null",
}).describe(
  "Configure or remove the OpenMeet group linked to this space. \
Only space admins can set this. Set groupSlug to null to disconnect the calendar.",
);

// All calendar events
export const CalendarEventVariant = SetCalendarLinkSchema;

export const SetCalendarLink = defineEvent(
  SetCalendarLinkSchema,
  ({ streamId, event }) => {
    const statements: SqlStatement[] = [];

    if (event.groupSlug === null) {
      // Removal: null groupSlug means disconnect the calendar
      statements.push(
        sql`delete from comp_calendar_link where entity = ${streamId}`,
      );
    } else {
      // Add/update: upsert the calendar link
      statements.push(
        sql`
          insert or replace into comp_calendar_link (entity, group_slug, tenant_id, api_url)
          values (${streamId}, ${event.groupSlug}, ${event.tenantId}, ${event.apiUrl})
        `,
      );
    }

    return statements;
  },
);
