import { describe, it, expect } from "vitest";
import { SpaceMetaSynthetic } from "../../src/schema/events/synthetic";

describe("SpaceMetaSynthetic Schema Version", () => {
  it("should accept valid schema with schema version 5", () => {
    const validEvent = {
      $type: "space.roomy.query.spaceMeta.v0",
      latestIdx: 100,
      schemaVersion: "5",
      info: {
        name: "Test Space",
        avatar: null,
        description: "A test space",
        handleProvider: null,
      },
      sidebar: { categories: [] },
      channels: [],
      admins: ["did:plc:abc123"],
      openmeetConfig: {
        groupSlug: null,
        tenantId: null,
        apiUrl: null,
      },
    };

    const result = SpaceMetaSynthetic.schema(validEvent);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.schemaVersion).toBe("5");
    }
  });

  it("should accept valid schema with schema version higher than 5", () => {
    const validEvent = {
      $type: "space.roomy.query.spaceMeta.v0",
      latestIdx: 100,
      schemaVersion: "6",
      info: {
        name: "Test Space",
        avatar: null,
        description: "A test space",
        handleProvider: null,
      },
      sidebar: { categories: [] },
      channels: [],
      admins: ["did:plc:abc123"],
      openmeetConfig: {
        groupSlug: null,
        tenantId: null,
        apiUrl: null,
      },
    };

    const result = SpaceMetaSynthetic.schema(validEvent);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.schemaVersion).toBe("6");
    }
  });

  it("should accept schema with null schema version (old module)", () => {
    const validEvent = {
      $type: "space.roomy.query.spaceMeta.v0",
      latestIdx: 100,
      schemaVersion: null,
      info: {
        name: "Test Space",
        avatar: null,
        description: "A test space",
        handleProvider: null,
      },
      sidebar: { categories: [] },
      channels: [],
      admins: ["did:plc:abc123"],
      openmeetConfig: {
        groupSlug: null,
        tenantId: null,
        apiUrl: null,
      },
    };

    const result = SpaceMetaSynthetic.schema(validEvent);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.schemaVersion).toBe(null);
    }
  });

  it("should accept schema with schema version less than 5", () => {
    const validEvent = {
      $type: "space.roomy.query.spaceMeta.v0",
      latestIdx: 100,
      schemaVersion: "4",
      info: {
        name: "Test Space",
        avatar: null,
        description: "A test space",
        handleProvider: null,
      },
      sidebar: { categories: [] },
      channels: [],
      admins: ["did:plc:abc123"],
      openmeetConfig: {
        groupSlug: null,
        tenantId: null,
        apiUrl: null,
      },
    };

    const result = SpaceMetaSynthetic.schema(validEvent);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.schemaVersion).toBe("4");
    }
  });

  it("should handle missing schemaVersion field as undefined", () => {
    const eventWithoutVersion = {
      $type: "space.roomy.query.spaceMeta.v0",
      latestIdx: 100,
      // schemaVersion missing - should be treated as undefined
      info: {
        name: "Test Space",
        avatar: null,
        description: "A test space",
        handleProvider: null,
      },
      sidebar: { categories: [] },
      channels: [],
      admins: ["did:plc:abc123"],
      openmeetConfig: {
        groupSlug: null,
        tenantId: null,
        apiUrl: null,
      },
    };

    const result = SpaceMetaSynthetic.schema(eventWithoutVersion);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.schemaVersion).toBe(undefined);
    }
  });
});
