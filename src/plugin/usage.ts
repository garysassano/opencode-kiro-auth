import { KiroAuthDetails, ManagedAccount } from './types'

export async function fetchUsageLimits(auth: KiroAuthDetails): Promise<any> {
  const url = `https://q.${auth.region}.amazonaws.com/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
        'x-amzn-kiro-agent-mode': 'vibe',
        'amz-sdk-request': 'attempt=1; max=1'
      }
    })
    if (!res.ok) throw new Error(`Status: ${res.status}`)
    const data: any = await res.json()
    let usedCount = 0,
      limitCount = 0
    if (Array.isArray(data.usageBreakdownList)) {
      for (const s of data.usageBreakdownList) {
        if (s.freeTrialInfo) {
          usedCount += s.freeTrialInfo.currentUsage || 0
          limitCount += s.freeTrialInfo.usageLimit || 0
        }
        usedCount += s.currentUsage || 0
        limitCount += s.usageLimit || 0
      }
    }
    return { usedCount, limitCount, email: data.userInfo?.email }
  } catch (e) {
    throw e
  }
}

export function updateAccountQuota(
  account: ManagedAccount,
  usage: any,
  accountManager?: any
): void {
  const meta = {
    usedCount: usage.usedCount || 0,
    limitCount: usage.limitCount || 0,
    realEmail: usage.email
  }
  account.usedCount = meta.usedCount
  account.limitCount = meta.limitCount
  if (meta.realEmail) account.realEmail = meta.realEmail
  if (accountManager) accountManager.updateUsage(account.id, meta)
}
