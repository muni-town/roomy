//! Snapshots and digests: the TypeScript rebuild-equality oracle, ported.
//!
//! `streams/rebuildEquality.ts` answers "is this projection the one the log
//! determines?" by reading every derived table, canonicalising the rows and
//! hashing them. The same three primitives exist here so a digest from this
//! crate can be compared with one recorded there:
//!
//!   `snapshot_db`   read every derived table out of one database
//!   `diff_snapshots` name the tables two readings disagree on
//!   `digest_of`     one hash over a reading
//!
//! The rules are the oracle's, not a reinterpretation of them: columns in
//! declaration order, clock columns dropped, rows ordered by their own encoding,
//! a blob as `{"$bytes": "<base64>"}`, and a table contributing its name and
//! columns even when it has no rows.

use std::collections::BTreeMap;

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Map, Value as Json};
use sha2::{Digest as _, Sha256};

/// Columns carrying the derivation's instant rather than a value the log
/// determines (`CLOCK_COLUMNS`).
const CLOCK_COLUMNS: [&str; 5] = [
    "created_at",
    "updated_at",
    "fetched_at",
    "synced_at",
    "retry_after",
];

/// Tables holding no derived state at all (`NON_DERIVED_TABLES`).
const NON_DERIVED_TABLES: [&str; 2] = ["space_schema_version", "space_schema_migrations"];

/// Cursor tables each implementation owns and the other never writes
/// (`CURSOR_TABLES`).
const CURSOR_TABLES: [&str; 2] = ["materialization_cursor", "worker_cursor"];

/// Columns holding a cursor rather than a log-determined value
/// (`CURSOR_COLUMNS`).
const CURSOR_COLUMNS: [&str; 1] = ["backfilled_to"];

/// One table's rows, as read out of a per-space database.
#[derive(Debug, Clone, PartialEq)]
pub struct TableSnapshot {
    pub table: String,
    /// The table's columns in declaration order, clock columns dropped.
    pub columns: Vec<String>,
    /// Rows in canonical order; each row follows `columns`.
    pub rows: Vec<Vec<Json>>,
}

/// One table two readings disagree on.
#[derive(Debug, Clone, PartialEq)]
pub struct TableDivergence {
    pub table: String,
    pub before: Vec<Vec<Json>>,
    pub after: Vec<Vec<Json>>,
}

/// Read every derived table into a snapshot.
pub fn snapshot_db(conn: &Connection) -> Result<Vec<TableSnapshot>, rusqlite::Error> {
    let tables: Vec<String> = {
        let mut statement = conn.prepare(
            "select name from sqlite_master
              where type = 'table' and name not like 'sqlite_%'
              order by name",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };

    let mut out: Vec<TableSnapshot> = Vec::new();
    for table in tables {
        if NON_DERIVED_TABLES.contains(&table.as_str()) {
            continue;
        }
        let all_columns: Vec<String> = {
            let mut statement = conn.prepare("select name from pragma_table_info(?1)")?;
            let rows = statement.query_map([&table], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let columns: Vec<String> = all_columns
            .into_iter()
            .filter(|column| !CLOCK_COLUMNS.contains(&column.as_str()))
            .collect();

        let select = format!(
            "select {} from \"{}\"",
            columns
                .iter()
                .map(|column| format!("\"{column}\""))
                .collect::<Vec<_>>()
                .join(", "),
            table
        );
        let mut statement = conn.prepare(&select)?;
        let mut rows: Vec<Vec<Json>> = Vec::new();
        let mut cursor = statement.query([])?;
        while let Some(row) = cursor.next()? {
            let mut values: Vec<Json> = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                values.push(to_json(row.get_ref(index)?));
            }
            rows.push(values);
        }
        sort_rows(&mut rows);

        out.push(TableSnapshot {
            table,
            columns,
            rows,
        });
    }
    Ok(out)
}

/// The tables `before` and `after` disagree on, by name and rows.
pub fn diff_snapshots(before: &[TableSnapshot], after: &[TableSnapshot]) -> Vec<TableDivergence> {
    let after_by_table: BTreeMap<&str, &TableSnapshot> =
        after.iter().map(|t| (t.table.as_str(), t)).collect();
    let mut compared: Vec<&str> = Vec::new();
    let mut diverging: Vec<TableDivergence> = Vec::new();

    for table in before {
        compared.push(table.table.as_str());
        let other = after_by_table.get(table.table.as_str());
        let reading = encode_rows(&table.rows);
        match other {
            Some(other) if encode_rows(&other.rows) == reading => continue,
            Some(other) => diverging.push(TableDivergence {
                table: table.table.clone(),
                before: table.rows.clone(),
                after: other.rows.clone(),
            }),
            None => diverging.push(TableDivergence {
                table: table.table.clone(),
                before: table.rows.clone(),
                after: Vec::new(),
            }),
        }
    }

    for table in after {
        if compared.contains(&table.table.as_str()) {
            continue;
        }
        diverging.push(TableDivergence {
            table: table.table.clone(),
            before: Vec::new(),
            after: table.rows.clone(),
        });
    }
    diverging
}

/// SHA-256 over a snapshot, in the oracle's encoding.
pub fn digest_of(tables: &[TableSnapshot]) -> String {
    let mut sorted: Vec<&TableSnapshot> = tables.iter().collect();
    sorted.sort_by(|a, b| a.table.cmp(&b.table));

    let mut hash = Sha256::new();
    for table in sorted {
        hash.update(format!("{}:{}\n", table.table, table_columns(table)).as_bytes());
        for row in &table.rows {
            hash.update(format!("{}\n", encode_json(row)).as_bytes());
        }
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A snapshot with the cursor tables and columns dropped, for comparing two
/// implementations' projections of the same log.
pub fn worker_snapshot(tables: &[TableSnapshot]) -> Vec<TableSnapshot> {
    let mut out: Vec<TableSnapshot> = Vec::new();
    for table in tables {
        if CURSOR_TABLES.contains(&table.table.as_str()) {
            continue;
        }
        let keep: Vec<usize> = table
            .columns
            .iter()
            .enumerate()
            .filter(|(_, column)| !CURSOR_COLUMNS.contains(&column.as_str()))
            .map(|(index, _)| index)
            .collect();
        if keep.len() == table.columns.len() {
            out.push(table.clone());
            continue;
        }
        out.push(TableSnapshot {
            table: table.table.clone(),
            columns: keep.iter().map(|i| table.columns[*i].clone()).collect(),
            rows: table
                .rows
                .iter()
                .map(|row| keep.iter().map(|i| row[*i].clone()).collect())
                .collect(),
        });
    }
    out
}

fn table_columns(table: &TableSnapshot) -> Json {
    Json::Array(
        table
            .columns
            .iter()
            .map(|column| Json::String(column.clone()))
            .collect(),
    )
}

fn encode_rows(rows: &[Vec<Json>]) -> Vec<String> {
    rows.iter().map(|row| encode_json(row)).collect()
}

/// A row's canonical encoding: the values as a JSON array.
fn encode_json(row: &[Json]) -> String {
    Json::Array(row.to_vec()).to_string()
}

/// Rows in canonical order: by their encoding, so two readings that hold the
/// same rows in a different physical order compare equal.
fn sort_rows(rows: &mut [Vec<Json>]) {
    rows.sort_by_key(|row| encode_json(row));
}

/// A SQLite value as the JSON the oracle encodes.
fn to_json(value: ValueRef<'_>) -> Json {
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(value) => json!(value),
        // A real that is integral prints as an integer in JavaScript, and the
        // digest has to agree with that encoding.
        ValueRef::Real(value) if value.fract() == 0.0 => json!(value as i64),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        ValueRef::Text(bytes) => Json::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => {
            use base64::Engine as _;
            let mut marker = Map::new();
            marker.insert(
                "$bytes".to_string(),
                Json::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
            );
            Json::Object(marker)
        }
    }
}
