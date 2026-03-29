import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface BackupArtifact {
  file: string;
  fullPath: string;
  createdAt: string;
  bytes: number;
  sha256: string;
}

export class BackupService {
  constructor(
    private readonly dbPath: string,
    private readonly backupDir: string,
  ) {}

  private assertFileDatabase(): void {
    if (!this.dbPath || this.dbPath === ':memory:') {
      throw new Error('Backups require a file-based DATABASE_PATH');
    }
  }

  private ensureBackupDir(): void {
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  private checksumFile(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const content = fs.readFileSync(filePath);
    hash.update(content);
    return hash.digest('hex');
  }

  runBackup(now = new Date()): BackupArtifact {
    this.assertFileDatabase();

    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Database file not found: ${this.dbPath}`);
    }

    this.ensureBackupDir();

    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const file = `ocom-${stamp}.db`;
    const destination = path.join(this.backupDir, file);

    fs.copyFileSync(this.dbPath, destination);

    const stat = fs.statSync(destination);
    const sha256 = this.checksumFile(destination);

    const meta = {
      source: this.dbPath,
      backup: destination,
      createdAt: now.toISOString(),
      bytes: stat.size,
      sha256,
    };

    fs.writeFileSync(`${destination}.meta.json`, JSON.stringify(meta, null, 2), 'utf8');

    return {
      file,
      fullPath: destination,
      createdAt: meta.createdAt,
      bytes: stat.size,
      sha256,
    };
  }

  listBackups(limit = 30): BackupArtifact[] {
    this.ensureBackupDir();

    const files = fs.readdirSync(this.backupDir)
      .filter((name) => name.endsWith('.db'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(1, limit));

    return files.map((file) => {
      const fullPath = path.join(this.backupDir, file);
      const stat = fs.statSync(fullPath);
      const sha256 = this.checksumFile(fullPath);

      return {
        file,
        fullPath,
        createdAt: stat.mtime.toISOString(),
        bytes: stat.size,
        sha256,
      };
    });
  }

  restoreBackup(file: string): BackupArtifact {
    this.assertFileDatabase();

    const safeFile = path.basename(file);
    if (!safeFile.endsWith('.db')) {
      throw new Error('Backup file must end with .db');
    }

    const source = path.join(this.backupDir, safeFile);

    if (!fs.existsSync(source)) {
      throw new Error(`Backup not found: ${safeFile}`);
    }

    const dbDir = path.dirname(this.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    const tmpRestorePath = `${this.dbPath}.restore.tmp`;
    fs.copyFileSync(source, tmpRestorePath);
    fs.renameSync(tmpRestorePath, this.dbPath);

    const stat = fs.statSync(this.dbPath);
    const sha256 = this.checksumFile(this.dbPath);

    return {
      file: safeFile,
      fullPath: source,
      createdAt: new Date().toISOString(),
      bytes: stat.size,
      sha256,
    };
  }
}
