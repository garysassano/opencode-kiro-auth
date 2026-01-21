import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageMetadata } from '../types'

function getBaseDir(): string {
  const p = process.platform
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export const DB_PATH = join(getBaseDir(), 'kiro.db')

export class KiroDatabase {
  private db: Database
  constructor(path: string = DB_PATH) {
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = new Database(path)
    this.db.run('PRAGMA busy_timeout = 5000')
    this.init()
  }
  private init() {
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, real_email TEXT, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, client_id TEXT, client_secret TEXT, profile_arn TEXT,
        refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
        recovery_time INTEGER, last_used INTEGER DEFAULT 0
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage (
        account_id TEXT PRIMARY KEY, used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0,
        real_email TEXT, last_sync INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
      )
    `)
    this.db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
  }
  getAccounts(): any[] {
    return this.db.prepare('SELECT * FROM accounts').all()
  }
  upsertAccount(acc: any) {
    this.db
      .prepare(
        `
      INSERT INTO accounts (
        id, email, real_email, auth_method, region, client_id, client_secret,
        profile_arn, refresh_token, access_token, expires_at, rate_limit_reset,
        is_healthy, unhealthy_reason, recovery_time, last_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, real_email=excluded.real_email, auth_method=excluded.auth_method,
        region=excluded.region, client_id=excluded.client_id, client_secret=excluded.client_secret,
        profile_arn=excluded.profile_arn, refresh_token=excluded.refresh_token,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, is_healthy=excluded.is_healthy,
        unhealthy_reason=excluded.unhealthy_reason, recovery_time=excluded.recovery_time,
        last_used=excluded.last_used
    `
      )
      .run(
        acc.id,
        acc.email,
        acc.realEmail || null,
        acc.authMethod,
        acc.region,
        acc.clientId || null,
        acc.clientSecret || null,
        acc.profileArn || null,
        acc.refreshToken,
        acc.accessToken,
        acc.expiresAt,
        acc.rateLimitResetTime || 0,
        acc.isHealthy ? 1 : 0,
        acc.unhealthyReason || null,
        acc.recoveryTime || null,
        acc.lastUsed || 0
      )
  }
  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
  getUsage(): Record<string, UsageMetadata> {
    const rows = this.db.prepare('SELECT * FROM usage').all() as any[]
    const usage: Record<string, UsageMetadata> = {}
    for (const r of rows) {
      usage[r.account_id] = {
        usedCount: r.used_count,
        limitCount: r.limit_count,
        realEmail: r.real_email,
        lastSync: r.last_sync
      }
    }
    return usage
  }
  upsertUsage(id: string, meta: UsageMetadata) {
    this.db
      .prepare(
        `
      INSERT INTO usage (account_id, used_count, limit_count, real_email, last_sync)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        used_count=excluded.used_count, limit_count=excluded.limit_count,
        real_email=excluded.real_email, last_sync=excluded.last_sync
    `
      )
      .run(id, meta.usedCount, meta.limitCount, meta.realEmail || null, meta.lastSync)
  }
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row ? row.value : null
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, value)
  }
  close() {
    this.db.close()
  }
}
export const kiroDb = new KiroDatabase()
