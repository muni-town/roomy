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
//! The rules are the oracle's, not a reinterpretation of them: columns in name
//! order, clock columns dropped, rows ordered by their own encoding, a blob as
//! `{"$bytes": "<base64>"}`, and a table contributing its name and columns even
//! when it has no rows.

use std::collections::BTreeMap;

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Map, Value as Json};
use sha2::{Digest as _, Sha256};

/// The exclusions, read from the one manifest the TypeScript oracle, this
/// digest and the fixture exporter share
/// (`packages/appserver/src/db/oracle-exclusions.json`).
const EXCLUSIONS: &str = include_str!("../../../packages/appserver/src/db/oracle-exclusions.json");

/// The parsed manifest. Parsed once: it is a compile-time constant.
fn exclusions() -> &'static serde_json::Value {
    use std::sync::OnceLock;
    static PARSED: OnceLock<serde_json::Value> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(EXCLUSIONS).expect("the exclusion manifest is valid JSON")
    })
}

fn names(key: &str) -> Vec<String> {
    exclusions()
        .get(key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn contains(list: &[String], value: &str) -> bool {
    list.iter().any(|item| item == value)
}

/// The clock columns dropped from `table`: the global list plus the table's
/// own.
fn clock_columns(table: &str) -> Vec<String> {
    let mut columns = names("clockColumns");
    if let Some(per_table) = exclusions()
        .get("tableClockColumns")
        .and_then(|value| value.get(table))
        .and_then(|value| value.as_array())
    {
        columns.extend(
            per_table
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string)),
        );
    }
    columns
}

/// The global tables a projection is compared over.
pub fn global_tables() -> Vec<String> {
    names("globalTables")
}

/// One table's rows, as read out of a per-space database.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TableSnapshot {
    /// The table's name.
    pub table: String,
    /// The table's columns as the database declares them; each row follows
    /// this order.
    pub columns: Vec<String>,
    /// Rows in canonical order; each row follows `columns`.
    pub rows: Vec<Vec<Json>>,
}

/// One table two readings disagree on.
#[derive(Debug, Clone, PartialEq)]
pub struct TableDivergence {
    /// The table's name.
    pub table: String,
    /// The rows the first reading holds.
    pub before: Vec<Vec<Json>>,
    /// The rows the second reading holds.
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
    let non_derived = names("nonDerivedTables");
    let tables: Vec<String> = tables
        .into_iter()
        .filter(|table| !contains(&non_derived, table))
        .collect();
    snapshot_tables(conn, &tables)
}

/// Read `tables` out of one database, in the oracle's encoding.
///
/// The global DB is compared over the tables the manifest names
/// ([`global_tables`]) rather than over every table it holds: the rest is index,
/// profile, embed and lease state the gateway owns.
pub fn snapshot_tables(
    conn: &Connection,
    tables: &[String],
) -> Result<Vec<TableSnapshot>, rusqlite::Error> {
    let mut out: Vec<TableSnapshot> = Vec::new();
    for table in tables {
        let table = table.clone();
        let all_columns: Vec<String> = {
            let mut statement = conn.prepare("select name from pragma_table_info(?1)")?;
            let rows = statement.query_map([&table], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let dropped = clock_columns(&table);
        let columns: Vec<String> = all_columns
            .into_iter()
            .filter(|column| !contains(&dropped, column))
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
        let reading = encode_table(table);
        match other {
            Some(other) if encode_table(other) == reading => continue,
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
        let canonical = canonical_table(table);
        hash.update(format!("{}:{}\n", table.table, table_columns(&canonical)).as_bytes());
        for row in &canonical.rows {
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
    let cursor_tables = names("cursorTables");
    let cursor_columns = names("cursorColumns");
    let mut out: Vec<TableSnapshot> = Vec::new();
    for table in tables {
        if contains(&cursor_tables, &table.table) {
            continue;
        }
        let keep: Vec<usize> = table
            .columns
            .iter()
            .enumerate()
            .filter(|(_, column)| !contains(&cursor_columns, column))
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

/// One table in the form the comparison and the digest hash: columns sorted by
/// name, rows in canonical order, each row following the sorted columns.
///
/// Two readings of one table can declare the same columns in a different
/// order. A database created before a column existed is healed with
/// `alter table … add column`, which appends it; a database created from
/// `schema-space.sql` declares it where the schema line puts it. The values are
/// the same either way, so the position a column happens to hold must not read
/// as a difference.
fn canonical_table(table: &TableSnapshot) -> TableSnapshot {
    let mut order: Vec<usize> = (0..table.columns.len()).collect();
    order.sort_by(|a, b| table.columns[*a].cmp(&table.columns[*b]));
    let columns = order
        .iter()
        .map(|index| table.columns[*index].clone())
        .collect();
    let mut rows: Vec<Vec<Json>> = table
        .rows
        .iter()
        .map(|row| order.iter().map(|index| row[*index].clone()).collect())
        .collect();
    sort_rows(&mut rows);
    TableSnapshot {
        table: table.table.clone(),
        columns,
        rows,
    }
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

/// A table's canonical encoding: its columns, then one line per row.
fn encode_table(table: &TableSnapshot) -> String {
    let canonical = canonical_table(table);
    let mut lines = vec![table_columns(&canonical).to_string()];
    lines.extend(canonical.rows.iter().map(|row| encode_json(row)));
    lines.join("\n")
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
