import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as logger from '../logger'
import { kiroDb } from './sqlite'

function getBaseDir(): string {
  const p = process.platform
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export async function migrateJsonToSqlite() {
  const base = getBaseDir()
  const accPath = join(base, 'kiro-accounts.json')
  const usePath = join(base, 'kiro-usage.json')
  try {
    const accExists = await fs
      .access(accPath)
      .then(() => true)
      .catch(() => false)
    const useExists = await fs
      .access(usePath)
      .then(() => true)
      .catch(() => false)
    if (accExists) {
      const accData = JSON.parse(await fs.readFile(accPath, 'utf-8'))
      const useData = useExists ? JSON.parse(await fs.readFile(usePath, 'utf-8')) : { usage: {} }
      if (accData.accounts && Array.isArray(accData.accounts)) {
        const accounts = []
        for (const acc of accData.accounts) {
          const usage = useData.usage[acc.id] || {}
          accounts.push({
            ...acc,
            email: acc.realEmail || acc.email,
            rateLimitResetTime: acc.rateLimitResetTime || 0,
            isHealthy: acc.isHealthy !== false,
            failCount: 0,
            lastUsed: acc.lastUsed || 0,
            usedCount: usage.usedCount || 0,
            limitCount: usage.limitCount || 0,
            lastSync: usage.lastSync || 0
          })
        }
        await kiroDb.batchUpsertAccounts(accounts)
      }
      await fs.rename(accPath, accPath + '.bak')
      if (useExists) await fs.rename(usePath, usePath + '.bak')
    }
  } catch (e) {
    logger.error('Migration failed', e)
  }
}
