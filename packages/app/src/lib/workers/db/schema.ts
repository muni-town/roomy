// Having each SQL statement in a separate const is helpful for debugging and introspection

export const schema = {
  pragmaForeignKeys: `PRAGMA foreign_keys = ON`,
  spacesTable: `CREATE TABLE IF NOT EXISTS spaces (id BLOB PRIMARY KEY, stream BLOB, name TEXT, avatar TEXT, description TEXT, hidden INTEGER NOT NULL DEFAULT 0 )`,
  createEntitiesTable: `
CREATE TABLE IF NOT EXISTS entities (
  ulid BLOB PRIMARY KEY, 
  label TEXT CHECK(label IN ('notification', 'media', 'device', 'user', 'timeline', 'message', 'task', 'space')),
  created_at INTEGER
) STRICT`,
  createEntitiesIndex: `CREATE INDEX IF NOT EXISTS idx_entities_label ON entities (label)`,
  createEventsTable: `CREATE TABLE IF NOT EXISTS events (
  event_ulid BLOB PRIMARY KEY,
  entity_ulid BLOB REFERENCES entities(ulid) ON DELETE CASCADE,
  payload BLOB,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  applied INTEGER DEFAULT 0
) STRICT`,
  createEventsIndex: `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at)`,
  createEventsIndexEntityCreated: `CREATE INDEX IF NOT EXISTS idx_events_entity_created ON events (entity_ulid, created_at, event_ulid)`,
  createEdgesTable: `
CREATE TABLE IF NOT EXISTS edges (
    head BLOB NOT NULL,
    tail BLOB NOT NULL,
    label TEXT NOT NULL CHECK(label IN ('child', 'parent', 'subscribe', 'member', 'ban', 'hide', 'pin', 'last_read', 'embed', 'reply', 'link', 'author', 'reorder', 'source', 'avatar')),
    payload TEXT CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (head, tail, label),
    FOREIGN KEY (head) REFERENCES entities(ulid) ON DELETE CASCADE,
    FOREIGN KEY (tail) REFERENCES entities(ulid) ON DELETE CASCADE
) STRICT
`,
  createEdgesHeadIndex: `CREATE INDEX IF NOT EXISTS idx_edges_head ON edges (head)`,
  createEdgesTailIndex: `CREATE INDEX IF NOT EXISTS idx_edges_tail ON edges (tail)`,
  createEdgesHeadLabelIndex: `CREATE INDEX IF NOT EXISTS idx_edges_head_label ON edges (head, label)`,
  createEdgesTailLabelIndex: `CREATE INDEX IF NOT EXISTS idx_edges_tail_label ON edges (tail, label)`,
  createCompProfileTable: `
CREATE TABLE IF NOT EXISTS comp_profile (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    bluesky_handle TEXT,
    banner_url TEXT,
    joined_date INTEGER
) STRICT
`,
  createCompProfileIndex: `CREATE INDEX IF NOT EXISTS idx_profile_handle ON comp_profile (bluesky_handle)`,
  createCompConfigTable: `
CREATE TABLE IF NOT EXISTS comp_config (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    config TEXT CHECK (json_valid(config))
) STRICT
`,
  createCompConfigIndex: `CREATE INDEX IF NOT EXISTS idx_config_config ON comp_config (config)`,
  createCompPageTable: `
CREATE TABLE IF NOT EXISTS comp_page (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT
`,
  createCompUploadTable: `
CREATE TABLE IF NOT EXISTS comp_upload (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    type TEXT CHECK(type IN ('image','video','file')),
    status TEXT CHECK(status IN ('pending','processing','completed','failed')),
    url TEXT
) STRICT
`,
  createCompUploadIndex: `CREATE INDEX IF NOT EXISTS idx_upload_status ON comp_upload (status)`,
  createCompUserAccessTimesTable: `
CREATE TABLE IF NOT EXISTS comp_user_access_times (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    user_created_at INTEGER NOT NULL,
    user_updated_at INTEGER NOT NULL
) STRICT
`,
  createCompUserAccessTimesCreatedIndex: `CREATE INDEX IF NOT EXISTS idx_user_access_times ON comp_user_access_times (created_at)`,
  createCompUserAccessTimesIndexUpdated: `CREATE INDEX IF NOT EXISTS idx_user_access_times_updated ON comp_user_access_times (updated_at)`,
  createCompTextContentTable: `
CREATE TABLE IF NOT EXISTS comp_text_content (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    text TEXT,
    format TEXT
) STRICT
`,
  createCompTextContentIndex: `CREATE INDEX IF NOT EXISTS idx_text_content_text ON comp_text_content (text)`,
  createCompTextContentIndexFormat: `CREATE INDEX IF NOT EXISTS idx_text_content_format ON comp_text_content (format)`,
  createCompTextContentFtsTable: `
CREATE VIRTUAL TABLE IF NOT EXISTS comp_text_content_fts USING fts5(
    text, format, content='comp_text_content', content_rowid='rowid'
)
`,
  createCompNameTable: `
CREATE TABLE IF NOT EXISTS comp_name (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    name TEXT
) STRICT
`,
  createCompNameIndex: `CREATE INDEX IF NOT EXISTS idx_name_name ON comp_name (name)`,
  createCompMediaTable: `
CREATE TABLE IF NOT EXISTS comp_media (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    uri TEXT
) STRICT
`,
  createCompMediaIndex: `CREATE INDEX IF NOT EXISTS idx_media_uri ON comp_media (uri)`,
  createCompIdentifierTable: `
  CREATE TABLE IF NOT EXISTS comp_identifier (
      entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      public_key BLOB
  ) STRICT
  `,
  createCompIdentifierIndex: `CREATE INDEX IF NOT EXISTS idx_identifier_public_key ON comp_identifier (public_key)`,
  createCompDescriptionTable: `
  CREATE TABLE IF NOT EXISTS comp_description (
      entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      description TEXT
  ) STRICT
  `,
  createCompDescriptionIndex: `CREATE INDEX IF NOT EXISTS idx_description_description ON comp_description (description)`,
  createCompUrlTable: `
  CREATE TABLE IF NOT EXISTS comp_url (
      entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      url TEXT
  ) STRICT
  `,
  createCompUrlIndex: `CREATE INDEX IF NOT EXISTS idx_url_url ON comp_url (url)`,
} as const;
