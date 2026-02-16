/**
 * Calendar integration events: OpenMeet group linking
 */

import { sql } from "../../utils";
import { type } from "../primitives";
import { defineEvent } from "./utils";

const SetCalendarLinkSchema = type({
  $type: "'space.roomy.openmeet.configure.v0'",
  groupSlug: "string",
  tenantId: "string",
  apiUrl: "string",
}).describe(
  "Configure the OpenMeet group linked to this space. \
Only space admins can set this. Stores the group slug, tenant ID, and API URL.",
);

// All calendar events
export const CalendarEventVariant = SetCalendarLinkSchema;

export const SetCalendarLink = defineEvent(
  SetCalendarLinkSchema,
  ({ streamId, event }) => [
    sql`
      insert or replace into comp_calendar_link (entity, group_slug, tenant_id, api_url)
      values (${streamId}, ${event.groupSlug}, ${event.tenantId}, ${event.apiUrl})
    `,
  ],
);
