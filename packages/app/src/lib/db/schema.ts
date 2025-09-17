// Having each SQL statement in a separate const is helpful for debugging and introspection

export const pragmaLockingMode = `PRAGMA locking_mode=exclusive;`;
export const pragmaWal = `PRAGMA journal_mode = WAL;`;
export const pragmaForeignKeys = `PRAGMA foreign_keys = ON;`;

export const createEntitiesTable = `
CREATE TABLE IF NOT EXISTS entities (
  ulid BLOB PRIMARY KEY, 
  label TEXT CHECK(label IN ('notification', 'media', 'device', 'user', 'timeline', 'message', 'task', 'space')), 
  created_at INTEGER
) STRICT;`;
export const createEntitiesIndex = `CREATE INDEX IF NOT EXISTS idx_entities_label ON entities(label);`;

export const createEventsTable = `CREATE TABLE IF NOT EXISTS events (
  event_ulid BLOB PRIMARY KEY,
  entity_ulid BLOB REFERENCES entities(ulid) ON DELETE CASCADE,
  payload BLOB,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  applied INTEGER DEFAULT 0
) STRICT;`;
export const createEventsIndex = `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);`;
export const createEventsIndexEntityCreated = `CREATE INDEX IF NOT EXISTS idx_events_entity_created ON events(entity_ulid, created_at, event_ulid);`;

export const createEdgesTable = `
CREATE TABLE IF NOT EXISTS edges (
    head BLOB NOT NULL,
    tail BLOB NOT NULL,
    label TEXT NOT NULL CHECK(label IN ('child', 'parent', 'subscribe', 'member', 'ban', 'hide', 'pin', 'last_read', 'embed', 'reply', 'link', 'author', 'reorder', 'source', 'avatar')),
    payload TEXT CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (head, tail, label),
    FOREIGN KEY (head) REFERENCES entities(ulid) ON DELETE CASCADE,
    FOREIGN KEY (tail) REFERENCES entities(ulid) ON DELETE CASCADE
) STRICT;
`;

export const createEdgesHeadIndex = `CREATE INDEX IF NOT EXISTS idx_edges_head ON edges(head);`;
export const createEdgesTailIndex = `CREATE INDEX IF NOT EXISTS idx_edges_tail ON edges(tail);`;
export const createEdgesHeadLabelIndex = `CREATE INDEX IF NOT EXISTS idx_edges_head_label ON edges(head, label);`;
export const createEdgesTailLabelIndex = `CREATE INDEX IF NOT EXISTS idx_edges_tail_label ON edges(tail, label);`;

export const createCompProfileTable = `
CREATE TABLE IF NOT EXISTS comp_profile (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    bluesky_handle TEXT,
    banner_url TEXT,
    joined_date INTEGER
) STRICT;
`;
export const createCompProfileIndex = `CREATE INDEX IF NOT EXISTS idx_profile_handle ON comp_profile(blueskyHandle);`;

export const createCompConfigTable = `
CREATE TABLE IF NOT EXISTS comp_config (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    config TEXT CHECK (json_valid(config))
) STRICT;
`;
export const createCompConfigIndex = `CREATE INDEX IF NOT EXISTS idx_config_config ON comp_config(config);`;

export const createCompPageTable = `
CREATE TABLE IF NOT EXISTS comp_page (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
`;

export const createCompUploadTable = `
CREATE TABLE IF NOT EXISTS comp_upload (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    type TEXT CHECK(type IN ('image','video','file')),
    status TEXT CHECK(status IN ('pending','processing','completed','failed')),
    url TEXT
) STRICT;
`;
export const createCompUploadIndex = `CREATE INDEX IF NOT EXISTS idx_upload_status ON comp_upload(status);`;

export const createCompUserAccessTimesTable = `
CREATE TABLE IF NOT EXISTS comp_user_access_times (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    user_created_at INTEGER NOT NULL,
    user_updated_at INTEGER NOT NULL
) STRICT;
`;
export const createCompUserAccessTimesCreatedIndex = `CREATE INDEX IF NOT EXISTS idx_user_access_times ON comp_user_access_times(created_at);`;
export const createCompUserAccessTimesIndexUpdated = `CREATE INDEX IF NOT EXISTS idx_user_access_times_updated ON comp_user_access_times(updated_at);`;

export const createCompTextContentTable = `
CREATE TABLE IF NOT EXISTS comp_text_content (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    text TEXT,
    format TEXT
) STRICT;
`;
export const createCompTextContentIndex = `CREATE INDEX IF NOT EXISTS idx_text_content_text ON comp_text_content(text);`;
export const createCompTextContentIndexFormat = `CREATE INDEX IF NOT EXISTS idx_text_content_format ON comp_text_content(format);`;

export const createCompTextContentFtsTable = `
CREATE VIRTUAL TABLE IF NOT EXISTS comp_text_content_fts USING fts5(
    text, format, content='comp_text_content', content_rowid='rowid'
);
`;

export const createCompNameTable = `
CREATE TABLE IF NOT EXISTS comp_name (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    name TEXT
) STRICT;
`;
export const createCompNameIndex = `CREATE INDEX IF NOT EXISTS idx_name_name ON comp_name(name);`;

export const createCompMediaTable = `
CREATE TABLE IF NOT EXISTS comp_media (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    uri TEXT
) STRICT;
`;
export const createCompMediaIndex = `CREATE INDEX IF NOT EXISTS idx_media_uri ON comp_media(uri);`;

export const createCompIdentifierTable = `

CREATE TABLE IF NOT EXISTS comp_identifier (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    public_key BLOB
) STRICT;
`;
export const createCompIdentifierIndex = `CREATE INDEX IF NOT EXISTS idx_identifier_public_key ON comp_identifier(public_key);`;

export const createCompDescriptionTable = `
CREATE TABLE IF NOT EXISTS comp_description (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    description TEXT
) STRICT;
`;
export const createCompDescriptionIndex = `CREATE INDEX IF NOT EXISTS idx_description_description ON comp_description(description);`;

export const createCompUrlTable = `

CREATE TABLE IF NOT EXISTS comp_url (
    entity TEXT PRIMARY KEY REFERENCES entities(ulid) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    url TEXT
) STRICT;
`;
export const createCompUrlIndex = `CREATE INDEX IF NOT EXISTS idx_url_url ON comp_url(url);`;
