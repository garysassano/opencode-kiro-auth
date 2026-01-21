import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'

function getCliDbPath(): string {
  const p = platform()
  if (p === 'win32')
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'kiro-cli',
      'data.sqlite3'
    )
  if (p === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  return join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
}

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    for (const row of rows) {
      if (row.key.includes(':token')) {
        let data: any
        try {
          data = JSON.parse(row.value)
        } catch {
          continue
        }
        if (!data.access_token) continue
        const email = data.email || 'cli-account@kiro.dev'
        const authMethod = row.key.includes('odic') ? 'idc' : 'desktop'
        const clientId =
          data.client_id ||
          (authMethod === 'idc'
            ? JSON.parse(rows.find((r) => r.key.includes('device-registration'))?.value || '{}')
                .client_id
            : undefined)
        const clientSecret =
          data.client_secret ||
          (authMethod === 'idc'
            ? JSON.parse(rows.find((r) => r.key.includes('device-registration'))?.value || '{}')
                .client_secret
            : undefined)
        const id = createDeterministicAccountId(email, authMethod, clientId, data.profile_arn)
        const existing = kiroDb.getAccounts().find((a) => a.id === id)
        const cliExpiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0
        if (existing && existing.expires_at >= cliExpiresAt) continue
        kiroDb.upsertAccount({
          id,
          email,
          realEmail: data.real_email || email,
          authMethod,
          region: data.region || 'us-east-1',
          clientId,
          clientSecret,
          profileArn: data.profile_arn,
          refreshToken: data.refresh_token,
          accessToken: data.access_token,
          expiresAt: cliExpiresAt || Date.now() + 3600000,
          isHealthy: 1
        })
      }
    }
    cliDb.close()
  } catch (e) {
    logger.error('Sync failed', e)
  }
}

export async function writeToKiroCli(acc: any) {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath)
    cliDb.exec('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    const targetKey = acc.authMethod === 'idc' ? 'kirocli:odic:token' : 'kirocli:social:token'
    const row = rows.find((r) => r.key === targetKey || r.key.endsWith(targetKey))
    if (row) {
      const data = JSON.parse(row.value)
      data.access_token = acc.accessToken
      data.refresh_token = acc.refreshToken
      data.expires_at = new Date(acc.expiresAt).toISOString()
      cliDb.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(JSON.stringify(data), row.key)
    }
    cliDb.close()
  } catch (e) {
    logger.warn('Write back failed', e)
  }
}
