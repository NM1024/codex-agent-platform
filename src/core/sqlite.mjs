// Remove an obsolete request-level uniqueness rule while preserving historical
// rows, child foreign keys, indexes and every unrelated schema column.
export function removeTableUniqueness(db, table, columns) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  if (!schema) return;
  const constraint = new RegExp(",?\\s*UNIQUE\\s*\\(\\s*" + columns.join("\\s*,\\s*") + "\\s*\\)", "i");
  if (!constraint.test(schema)) return;
  const replacement = table + "_request_migration";
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  const auxiliary = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
  const fields = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => quote(row.name)).join(",");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(schema.replace(constraint, "").replace(/^(CREATE\s+TABLE\s+)(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)/i, "$1" + quote(replacement)));
    db.exec(`INSERT INTO ${quote(replacement)}(${fields}) SELECT ${fields} FROM ${quote(table)}`);
    db.exec(`DROP TABLE ${quote(table)}`);
    db.exec(`ALTER TABLE ${quote(replacement)} RENAME TO ${quote(table)}`);
    for (const item of auxiliary) db.exec(item.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("STORAGE_MIGRATION_FOREIGN_KEY_FAILURE");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
