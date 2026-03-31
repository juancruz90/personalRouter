const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const dbPath = path.join(projectRoot, 'data', 'openclaw.db');
const migrationsDir = path.join(__dirname, 'migrations');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
const applied = new Set(appliedRows.map((row) => row.version));

const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

for (const file of files) {
  if (applied.has(file)) {
    continue;
  }

  const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  db.exec('BEGIN;');

  try {
    db.exec(migrationSql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    db.exec('COMMIT;');
    console.log(`Applied migration: ${file}`);
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

console.log(`Database ready at ${dbPath}`);
db.close();
