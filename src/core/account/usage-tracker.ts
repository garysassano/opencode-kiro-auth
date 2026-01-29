import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota } from '../../plugin/usage'

interface UsageTrackerConfig {
  usage_tracking_enabled: boolean
  usage_sync_max_retries: number
}

export class UsageTracker {
  constructor(
    private config: UsageTrackerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {}

  async syncUsage(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    if (!this.config.usage_tracking_enabled) {
      return
    }

    this.syncWithRetry(account, auth, 0).catch(() => {})
  }

  private async syncWithRetry(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    attempt: number
  ): Promise<void> {
    try {
      const u = await fetchUsageLimits(auth)
      updateAccountQuota(account, u, this.accountManager)
      await this.repository.batchSave(this.accountManager.getAccounts())
    } catch (e: any) {
      if (attempt < this.config.usage_sync_max_retries) {
        await this.sleep(1000 * Math.pow(2, attempt))
        return this.syncWithRetry(account, auth, attempt + 1)
      }

      if (
        e.message?.includes('403') ||
        e.message?.includes('invalid') ||
        e.message?.includes('bearer token')
      ) {
        this.accountManager.markUnhealthy(account, e.message)
        this.repository.save(account).catch(() => {})
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
