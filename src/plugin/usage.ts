import { KiroAuthDetails, ManagedAccount } from './types'

export async function fetchUsageLimits(auth: KiroAuthDetails): Promise<any> {
  const url = new URL(`https://q.${auth.region}.amazonaws.com/getUsageLimits`)
  url.searchParams.set('isEmailRequired', 'true')
  url.searchParams.set('origin', 'AI_EDITOR')
  url.searchParams.set('resourceType', 'AGENTIC_REQUEST')
  if (auth.profileArn) url.searchParams.set('profileArn', auth.profileArn)
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
        'x-amzn-kiro-agent-mode': 'vibe',
        'amz-sdk-request': 'attempt=1; max=1'
      }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const requestId =
        res.headers.get('x-amzn-requestid') ||
        res.headers.get('x-amzn-request-id') ||
        res.headers.get('x-amz-request-id') ||
        ''
      const errType =
        res.headers.get('x-amzn-errortype') || res.headers.get('x-amzn-error-type') || ''
      const msg =
        body && body.length > 0
          ? `${body.slice(0, 2000)}${body.length > 2000 ? '…' : ''}`
          : `HTTP ${res.status}`
      throw new Error(
        `Status: ${res.status}${errType ? ` (${errType})` : ''}${
          requestId ? ` [${requestId}]` : ''
        }: ${msg}`
      )
    }
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
    email: usage.email
  }
  account.usedCount = meta.usedCount
  account.limitCount = meta.limitCount
  if (usage.email) account.email = usage.email
  if (accountManager) accountManager.updateUsage(account.id, meta)
}
