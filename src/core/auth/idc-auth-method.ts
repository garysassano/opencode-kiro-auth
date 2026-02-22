import type { AuthOuathResult } from '@opencode-ai/plugin'
import { exec } from 'node:child_process'
import { normalizeRegion } from '../../constants.js'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { authorizeKiroIDC, pollKiroIDCToken } from '../../kiro/oauth-idc.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import * as logger from '../../plugin/logger.js'
import type { KiroRegion, ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

const openBrowser = (url: string) => {
  const escapedUrl = url.replace(/"/g, '\\"')
  const platform = process.platform
  const cmd =
    platform === 'win32'
      ? `cmd /c start "" "${escapedUrl}"`
      : platform === 'darwin'
        ? `open "${escapedUrl}"`
        : `xdg-open "${escapedUrl}"`
  exec(cmd, (error) => {
    if (error) logger.warn(`Browser error: ${error.message}`)
  })
}

function normalizeStartUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const url = new URL(trimmed)
  url.hash = ''
  url.search = ''

  // Normalize common portal URL shapes to end in `/start` (AWS Builder ID and IAM Identity Center)
  if (url.pathname.endsWith('/start/')) url.pathname = url.pathname.replace(/\/start\/$/, '/start')
  if (!url.pathname.endsWith('/start')) url.pathname = url.pathname.replace(/\/+$/, '') + '/start'

  return url.toString()
}

export class IdcAuthMethod {
  constructor(
    private config: any,
    private repository: AccountRepository,
    private accountManager: any
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<AuthOuathResult> {
    const serviceRegion: KiroRegion = this.config.default_region
    const startUrl = normalizeStartUrl(inputs?.start_url || this.config.idc_start_url)
    const oidcRegion: KiroRegion = normalizeRegion(inputs?.idc_region || this.config.idc_region)

    // Step 1: get device code + verification URL (fast)
    const auth = await authorizeKiroIDC(oidcRegion, startUrl)
    const verificationUrl = auth.verificationUriComplete || auth.verificationUrl

    // Open the *AWS* verification page directly (no local web server).
    openBrowser(verificationUrl)

    return {
      url: verificationUrl,
      instructions: `Open the verification URL and complete sign-in.\nCode: ${auth.userCode}\nURL: ${auth.verificationUrl}`,
      method: 'auto',
      callback: async (): Promise<{ type: 'success'; key: string } | { type: 'failed' }> => {
        try {
          // Step 2: poll until token is issued (standard device-code flow)
          const token = await pollKiroIDCToken(
            auth.clientId,
            auth.clientSecret,
            auth.deviceCode,
            auth.interval,
            auth.expiresIn,
            oidcRegion
          )

          const usage = await fetchUsageLimits({
            refresh: '',
            access: token.accessToken,
            expires: token.expiresAt,
            authMethod: 'idc',
            region: serviceRegion,
            clientId: token.clientId,
            clientSecret: token.clientSecret
          })
          if (!usage.email) return { type: 'failed' }

          const id = createDeterministicAccountId(usage.email, 'idc', token.clientId)
          const acc: ManagedAccount = {
            id,
            email: usage.email,
            authMethod: 'idc',
            region: serviceRegion,
            oidcRegion,
            clientId: token.clientId,
            clientSecret: token.clientSecret,
            startUrl: startUrl || undefined,
            refreshToken: token.refreshToken,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            rateLimitResetTime: 0,
            isHealthy: true,
            failCount: 0,
            usedCount: usage.usedCount,
            limitCount: usage.limitCount
          }

          await this.repository.save(acc)
          this.accountManager?.addAccount?.(acc)

          return { type: 'success', key: token.accessToken }
        } catch (e: any) {
          logger.warn('IDC auth callback failed', e)
          return { type: 'failed' }
        }
      }
    }
  }
}
