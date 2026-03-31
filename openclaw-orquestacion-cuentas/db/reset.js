const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'openclaw.db');
const sidecars = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`, `${dbPath}-journal`];

for (const file of sidecars) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`Deleted ${file}`);
  }
}

console.log('Database reset complete');
