import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

interface DbProjectRow {
  id: number;
  name: string;
  created_at: string;
}

interface DbAgentRow {
  id: number;
  slug: string;
  name: string | null;
  workspace: string | null;
  default_model: string | null;
  created_at: string;
}

export interface SeededProject {
  id: number;
  name: string;
  createdAt: string;
}

export interface SeededAgent {
  id: number;
  slug: string;
  name: string | null;
  workspace: string | null;
  defaultModel: string | null;
  createdAt: string;
}

export interface PersonalProviderSeedResult {
  project: SeededProject;
  agents: SeededAgent[];
}

interface BaseAgentConfig {
  slug: string;
  name: string;
  workspace: string;
  defaultModel: string;
}

const BASE_AGENTS: BaseAgentConfig[] = [
  {
    slug: 'florencia',
    name: 'Florencia',
    workspace: './',
    defaultModel: 'openai-codex/gpt-5.3-codex',
  },
  {
    slug: 'condor',
    name: 'Condor',
    workspace: './agents/condor',
    defaultModel: 'openai-codex/gpt-5.3-codex',
  },
  {
    slug: 'lince',
    name: 'Lince',
    workspace: './agents/lince',
    defaultModel: 'openai-codex/gpt-5.3-codex',
  },
  {
    slug: 'puma',
    name: 'Puma',
    workspace: './agents/puma',
    defaultModel: 'openai-codex/gpt-5.3-codex',
  },
  {
    slug: 'yaguarete',
    name: 'Yaguarete',
    workspace: './agents/yaguarete',
    defaultModel: 'openai-codex/gpt-5.3-codex',
  },
];

function openDatabase(dbPath: string): Promise<sqlite3.Database> {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(db);
    });
  });
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function runStatement(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        lastID: this.lastID || 0,
        changes: this.changes || 0,
      });
    });
  });
}

function getOne<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

function getAll<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((rows || []) as T[]);
    });
  });
}

function mapProject(row: DbProjectRow): SeededProject {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function mapAgent(row: DbAgentRow): SeededAgent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    workspace: row.workspace,
    defaultModel: row.default_model,
    createdAt: row.created_at,
  };
}

export class SeedService {
  constructor(private readonly dbPath: string) {}

  private async withDatabase<T>(work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.dbPath);

    try {
      return await work(db);
    } finally {
      await closeDatabase(db);
    }
  }

  private async ensureSchema(db: sqlite3.Database): Promise<void> {
    await runStatement(
      db,
      `
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `,
    );

    await runStatement(
      db,
      `
        CREATE TABLE IF NOT EXISTS agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT,
          workspace TEXT,
          default_model TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `,
    );
  }

  async seedPersonalProvider(): Promise<PersonalProviderSeedResult> {
    return this.withDatabase(async (db) => {
      await this.ensureSchema(db);

      await runStatement(
        db,
        `
          INSERT INTO projects (name)
          VALUES ('personal-provider')
          ON CONFLICT(name) DO NOTHING
        `,
      );

      for (const agent of BASE_AGENTS) {
        await runStatement(
          db,
          `
            INSERT INTO agents (slug, name, workspace, default_model)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              name = excluded.name,
              workspace = excluded.workspace,
              default_model = excluded.default_model
          `,
          [agent.slug, agent.name, agent.workspace, agent.defaultModel],
        );
      }

      const projectRow = await getOne<DbProjectRow>(
        db,
        `
          SELECT id, name, created_at
          FROM projects
          WHERE name = 'personal-provider'
          LIMIT 1
        `,
      );

      if (!projectRow) {
        throw new Error('Failed to seed project personal-provider');
      }

      const placeholders = BASE_AGENTS.map(() => '?').join(', ');
      const agents = await getAll<DbAgentRow>(
        db,
        `
          SELECT id, slug, name, workspace, default_model, created_at
          FROM agents
          WHERE slug IN (${placeholders})
          ORDER BY slug ASC
        `,
        BASE_AGENTS.map((agent) => agent.slug),
      );

      return {
        project: mapProject(projectRow),
        agents: agents.map(mapAgent),
      };
    });
  }
}
