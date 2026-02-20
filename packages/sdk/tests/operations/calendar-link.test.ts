/**
 * Tests for SetCalendarLink event schema and materializer.
 */

import { describe, it, expect } from "vitest";
import { SetCalendarLink } from "../../src/schema/events/calendar";

describe("SetCalendarLink", () => {
  it("produces insert-or-replace SQL with correct field mapping", () => {
    const streamId = "did:web:test.roomy.chat";
    const event = {
      $type: "space.roomy.openmeet.configure.v0" as const,
      groupSlug: "my-group",
      tenantId: "tenant-abc",
      apiUrl: "https://api.openmeet.net",
    };

    const statements = SetCalendarLink.materialize({
      streamId,
      user: "did:plc:user123",
      event,
    });

    expect(statements).toHaveLength(1);
    const stmt = statements[0];
    expect(stmt.sql).toContain("insert or replace into comp_calendar_link");
    expect(stmt.sql).toContain("entity");
    expect(stmt.sql).toContain("group_slug");
    expect(stmt.sql).toContain("tenant_id");
    expect(stmt.sql).toContain("api_url");
    // Params: streamId, groupSlug, tenantId, apiUrl
    expect(stmt.params).toEqual([
      streamId,
      "my-group",
      "tenant-abc",
      "https://api.openmeet.net",
    ]);
  });

  it("maps all event fields to correct SQL columns", () => {
    const statements = SetCalendarLink.materialize({
      streamId: "did:web:space1",
      user: "did:plc:admin",
      event: {
        $type: "space.roomy.openmeet.configure.v0" as const,
        groupSlug: "slug-with-dashes",
        tenantId: "tenant/special",
        apiUrl: "http://localhost:3000",
      },
    });

    const stmt = statements[0];
    // The sql template replaces params with ?, so 4 placeholders expected
    const placeholders = stmt.sql.match(/\?/g);
    expect(placeholders).toHaveLength(4);
    expect(stmt.params).toEqual([
      "did:web:space1",
      "slug-with-dashes",
      "tenant/special",
      "http://localhost:3000",
    ]);
  });
});
