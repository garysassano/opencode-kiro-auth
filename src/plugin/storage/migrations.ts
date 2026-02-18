import type { Database } from 'bun:sqlite'

export function runMigrations(db: Database): void {
  migrateToUniqueRefreshToken(db)
  migrateRealEmailColumn(db)
  migrateUsageTable(db)
  migrateStartUrlColumn(db)
}

function migrateToUniqueRefreshToken(db: Database): void {
  const hasIndex = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_refresh_token_unique'"
    )
    .get()

  if (hasIndex) return

  db.run('BEGIN TRANSACTION')
  try {
    const duplicates = db
      .prepare(
        `
        SELECT refresh_token, COUNT(*) as count 
        FROM accounts 
        GROUP BY refresh_token 
        HAVING count > 1
      `
      )
      .all() as any[]

    for (const dup of duplicates) {
      const accounts = db
        .prepare(
          'SELECT * FROM accounts WHERE refresh_token = ? ORDER BY last_used DESC, expires_at DESC'
        )
        .all(dup.refresh_token) as any[]

      if (accounts.length > 1) {
        const keep = accounts[0]
        const remove = accounts.slice(1)

        const mergedUsedCount = Math.max(...accounts.map((a: any) => a.used_count || 0))
        const mergedLimitCount = Math.max(...accounts.map((a: any) => a.limit_count || 0))
        const mergedLastUsed = Math.max(...accounts.map((a: any) => a.last_used || 0))
        const mergedFailCount = Math.max(...accounts.map((a: any) => a.fail_count || 0))

        db.prepare(
          `
            UPDATE accounts SET 
              used_count = ?, 
              limit_count = ?, 
              last_used = ?,
              fail_count = ?
            WHERE id = ?
          `
        ).run(mergedUsedCount, mergedLimitCount, mergedLastUsed, mergedFailCount, keep.id)

        for (const acc of remove) {
          db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id)
        }
      }
    }

    db.run('CREATE UNIQUE INDEX idx_refresh_token_unique ON accounts(refresh_token)')
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

function migrateRealEmailColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (names.has('real_email')) {
    db.run('BEGIN TRANSACTION')
    try {
      db.run(
        "UPDATE accounts SET email = real_email WHERE real_email IS NOT NULL AND real_email != '' AND email LIKE 'builder-id@aws.amazon.com%'"
      )
      db.run(`
          CREATE TABLE accounts_new (
            id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
            region TEXT NOT NULL, client_id TEXT, client_secret TEXT, profile_arn TEXT,
            refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
            rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
            recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
            used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
          )
        `)
      db.run(`
          INSERT INTO accounts_new (id, email, auth_method, region, client_id, client_secret, profile_arn, refresh_token, access_token, expires_at, rate_limit_reset, is_healthy, unhealthy_reason, recovery_time, fail_count, last_used, used_count, limit_count, last_sync)
          SELECT id, email, auth_method, region, client_id, client_secret, profile_arn, refresh_token, access_token, expires_at, COALESCE(rate_limit_reset, 0), COALESCE(is_healthy, 1), unhealthy_reason, recovery_time, COALESCE(fail_count, 0), COALESCE(last_used, 0), 0, 0, 0 FROM accounts
        `)
      db.run('DROP TABLE accounts')
      db.run('ALTER TABLE accounts_new RENAME TO accounts')
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
    }
  } else {
    const needed: Record<string, string> = {
      fail_count: 'INTEGER DEFAULT 0',
      used_count: 'INTEGER DEFAULT 0',
      limit_count: 'INTEGER DEFAULT 0',
      last_sync: 'INTEGER DEFAULT 0'
    }
    for (const [n, d] of Object.entries(needed)) {
      if (!names.has(n)) db.run(`ALTER TABLE accounts ADD COLUMN ${n} ${d}`)
    }
  }
}

function migrateUsageTable(db: Database): void {
  const hasUsageTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'")
    .get()
  if (hasUsageTable) {
    db.run(`
        UPDATE accounts SET 
          used_count = COALESCE((SELECT used_count FROM usage WHERE usage.account_id = accounts.id), used_count),
          limit_count = COALESCE((SELECT limit_count FROM usage WHERE usage.account_id = accounts.id), limit_count),
          last_sync = COALESCE((SELECT last_sync FROM usage WHERE usage.account_id = accounts.id), last_sync)
      `)
    db.run('DROP TABLE usage')
  }
}

function migrateStartUrlColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('start_url')) {
    db.run('ALTER TABLE accounts ADD COLUMN start_url TEXT')
  }
}
