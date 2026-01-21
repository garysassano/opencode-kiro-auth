import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as logger from '../logger'
import { kiroDb } from './sqlite'

function getBaseDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
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
    if (accExists) {
      const data = JSON.parse(await fs.readFile(accPath, 'utf-8'))
      if (data.accounts && Array.isArray(data.accounts)) {
        for (const acc of data.accounts) {
          kiroDb.upsertAccount({
            ...acc,
            rateLimitResetTime: acc.rateLimitResetTime || 0,
            isHealthy: acc.isHealthy !== false,
            lastUsed: acc.lastUsed || 0
          })
        }
      }
      await fs.rename(accPath, accPath + '.bak')
    }

    const useExists = await fs
      .access(usePath)
      .then(() => true)
      .catch(() => false)
    if (useExists) {
      const data = JSON.parse(await fs.readFile(usePath, 'utf-8'))
      if (data.usage && typeof data.usage === 'object') {
        for (const [id, meta] of Object.entries(data.usage)) {
          kiroDb.upsertUsage(id, meta as any)
        }
      }
      await fs.rename(usePath, usePath + '.bak')
    }
  } catch (e) {
    logger.error('Migration failed', e)
  }
}
