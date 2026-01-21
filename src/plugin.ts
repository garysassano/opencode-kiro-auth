import { exec } from 'node:child_process'
import { KIRO_CONSTANTS } from './constants'
import { accessTokenExpired, encodeRefreshToken } from './kiro/auth'
import type { KiroIDCTokenResult } from './kiro/oauth-idc'
import { authorizeKiroIDC } from './kiro/oauth-idc'
import { AccountManager, generateAccountId } from './plugin/accounts'
import { promptAddAnotherAccount, promptLoginMode } from './plugin/cli'
import { loadConfig } from './plugin/config'
import { KiroTokenRefreshError } from './plugin/errors'
import * as logger from './plugin/logger'
import { transformToCodeWhisperer } from './plugin/request'
import { parseEventStream } from './plugin/response'
import { startIDCAuthServer } from './plugin/server'
import { migrateJsonToSqlite } from './plugin/storage/migration'
import { transformKiroStream } from './plugin/streaming'
import { syncFromKiroCli } from './plugin/sync/kiro-cli'
import { refreshAccessToken } from './plugin/token'
import type { ManagedAccount } from './plugin/types'
import { fetchUsageLimits, updateAccountQuota } from './plugin/usage'

const KIRO_PROVIDER_ID = 'kiro'
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isNetworkError = (e: any) =>
  e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
const extractModel = (url: string) => url.match(/models\/([^/:]+)/)?.[1] || null
const formatUsageMessage = (usedCount: number, limitCount: number, email: string): string => {
  if (limitCount > 0) {
    const percentage = Math.round((usedCount / limitCount) * 100)
    return `Usage (${email}): ${usedCount}/${limitCount} (${percentage}%)`
  }
  return `Usage (${email}): ${usedCount}`
}
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
export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)
    const showToast = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }
    return {
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await migrateJsonToSqlite()
          if (config.auto_sync_kiro_cli) await syncFromKiroCli()
          const am = await AccountManager.loadFromDisk(config.account_selection_strategy)
          return {
            apiKey: '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
              '{{region}}',
              config.default_region || 'us-east-1'
            ),
            async fetch(input: any, init?: any): Promise<Response> {
              const url = typeof input === 'string' ? input : input.url
              if (!KIRO_API_PATTERN.test(url)) return fetch(input, init)
              const body = init?.body ? JSON.parse(init.body) : {}
              const model = extractModel(url) || body.model || 'claude-sonnet-4-5'
              const think = model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig
              const budget = body.providerOptions?.thinkingConfig?.thinkingBudget || 20000
              let retry = 0,
                iterations = 0,
                reductionFactor = 1.0
              const startTime = Date.now(),
                maxIterations = config.max_request_iterations,
                timeoutMs = config.request_timeout_ms
              while (true) {
                iterations++
                if (iterations > maxIterations)
                  throw new Error(`Exceeded max iterations (${maxIterations})`)
                if (Date.now() - startTime > timeoutMs) throw new Error('Request timeout')
                const count = am.getAccountCount()
                if (count === 0) throw new Error('No accounts')
                const acc = am.getCurrentOrNext()
                if (!acc) {
                  const wait = am.getMinWaitTime()
                  if (wait > 0 && wait < 30000) {
                    if (am.shouldShowToast())
                      showToast(
                        `All accounts rate-limited. Waiting ${Math.ceil(wait / 1000)}s...`,
                        'warning'
                      )
                    await sleep(wait)
                    continue
                  }
                  throw new Error('All accounts are unhealthy or rate-limited')
                }
                if (count > 1 && am.shouldShowToast())
                  showToast(
                    `Using ${acc.realEmail || acc.email} (${am.getAccounts().indexOf(acc) + 1}/${count})`,
                    'info'
                  )
                if (
                  am.shouldShowUsageToast() &&
                  acc.usedCount !== undefined &&
                  acc.limitCount !== undefined
                ) {
                  const p = acc.limitCount > 0 ? (acc.usedCount / acc.limitCount) * 100 : 0
                  showToast(
                    formatUsageMessage(acc.usedCount, acc.limitCount, acc.realEmail || acc.email),
                    p >= 80 ? 'warning' : 'info'
                  )
                }
                const auth = am.toAuthDetails(acc)
                if (accessTokenExpired(auth, config.token_expiry_buffer_ms)) {
                  try {
                    const newAuth = await refreshAccessToken(auth)
                    am.updateFromAuth(acc, newAuth)
                    await am.saveToDisk()
                  } catch (e: any) {
                    if (config.auto_sync_kiro_cli) await syncFromKiroCli()
                    const refreshedAm = await AccountManager.loadFromDisk(
                      config.account_selection_strategy
                    )
                    const stillAcc = refreshedAm.getAccounts().find((a) => a.id === acc.id)
                    if (
                      stillAcc &&
                      !accessTokenExpired(
                        refreshedAm.toAuthDetails(stillAcc),
                        config.token_expiry_buffer_ms
                      )
                    ) {
                      showToast('Credentials recovered from Kiro CLI sync.', 'info')
                      continue
                    }
                    if (
                      e instanceof KiroTokenRefreshError &&
                      (e.code === 'ExpiredTokenException' ||
                        e.code === 'InvalidTokenException' ||
                        e.code === 'HTTP_401' ||
                        e.code === 'HTTP_403')
                    ) {
                      am.markUnhealthy(acc, e.message)
                      await am.saveToDisk()
                      continue
                    }
                    throw e
                  }
                }
                const prepRequest = (f: number) =>
                  transformToCodeWhisperer(url, init?.body, model, auth, think, budget, f)
                let prep = prepRequest(reductionFactor)
                const apiTimestamp = config.enable_log_api_request ? logger.getTimestamp() : null
                if (config.enable_log_api_request && apiTimestamp) {
                  let parsedBody = null
                  try {
                    parsedBody = prep.init.body ? JSON.parse(prep.init.body as string) : null
                  } catch {}
                  logger.logApiRequest(
                    {
                      url: prep.url,
                      method: prep.init.method,
                      headers: prep.init.headers,
                      body: parsedBody,
                      conversationId: prep.conversationId,
                      model: prep.effectiveModel,
                      email: acc.realEmail || acc.email
                    },
                    apiTimestamp
                  )
                }
                try {
                  const res = await fetch(prep.url, prep.init)
                  if (config.enable_log_api_request && apiTimestamp) {
                    const h: any = {}
                    res.headers.forEach((v, k) => {
                      h[k] = v
                    })
                    logger.logApiResponse(
                      {
                        status: res.status,
                        statusText: res.statusText,
                        headers: h,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel
                      },
                      apiTimestamp
                    )
                  }
                  if (res.ok) {
                    if (config.usage_tracking_enabled) {
                      const sync = async (att = 0): Promise<void> => {
                        try {
                          const u = await fetchUsageLimits(auth)
                          updateAccountQuota(acc, u, am)
                          await am.saveToDisk()
                        } catch (e: any) {
                          if (att < config.usage_sync_max_retries) {
                            await sleep(1000 * Math.pow(2, att))
                            return sync(att + 1)
                          }
                        }
                      }
                      sync().catch(() => {})
                    }
                    if (prep.streaming) {
                      const s = transformKiroStream(res, model, prep.conversationId)
                      return new Response(
                        new ReadableStream({
                          async start(c) {
                            try {
                              for await (const e of s)
                                c.enqueue(
                                  new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)
                                )
                              c.close()
                            } catch (err) {
                              c.error(err)
                            }
                          }
                        }),
                        { headers: { 'Content-Type': 'text/event-stream' } }
                      )
                    }
                    const text = await res.text(),
                      p = parseEventStream(text),
                      oai: any = {
                        id: prep.conversationId,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [
                          {
                            index: 0,
                            message: { role: 'assistant', content: p.content },
                            finish_reason: p.stopReason === 'tool_use' ? 'tool_calls' : 'stop'
                          }
                        ],
                        usage: {
                          prompt_tokens: p.inputTokens || 0,
                          completion_tokens: p.outputTokens || 0,
                          total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0)
                        }
                      }
                    if (p.toolCalls.length > 0)
                      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
                        id: tc.toolUseId,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments:
                            typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
                        }
                      }))
                    return new Response(JSON.stringify(oai), {
                      headers: { 'Content-Type': 'application/json' }
                    })
                  }
                  if (res.status === 400 && reductionFactor > 0.4) {
                    reductionFactor -= 0.2
                    showToast(
                      `Context too long. Retrying with ${Math.round(reductionFactor * 100)}%...`,
                      'warning'
                    )
                    prep = prepRequest(reductionFactor)
                    continue
                  }
                  if (res.status === 401 && retry < config.rate_limit_max_retries) {
                    retry++
                    continue
                  }
                  if (res.status === 429) {
                    const w = parseInt(res.headers.get('retry-after') || '60') * 1000
                    am.markRateLimited(acc, w)
                    await am.saveToDisk()
                    if (count > 1) {
                      showToast(`Rate limited. Switching account...`, 'warning')
                      continue
                    }
                    showToast(`Rate limited. Waiting ${Math.ceil(w / 1000)}s...`, 'warning')
                    await sleep(w)
                    continue
                  }
                  if ((res.status === 402 || res.status === 403) && count > 1) {
                    am.markUnhealthy(acc, res.status === 402 ? 'Quota' : 'Forbidden')
                    await am.saveToDisk()
                    continue
                  }
                  const h: any = {}
                  res.headers.forEach((v, k) => {
                    h[k] = v
                  })
                  const rData = {
                    status: res.status,
                    statusText: res.statusText,
                    headers: h,
                    error: `Kiro Error: ${res.status}`,
                    conversationId: prep.conversationId,
                    model: prep.effectiveModel
                  }
                  let lastBody = null
                  try {
                    lastBody = prep.init.body ? JSON.parse(prep.init.body as string) : null
                  } catch {}
                  if (!config.enable_log_api_request)
                    logger.logApiError(
                      {
                        url: prep.url,
                        method: prep.init.method,
                        headers: prep.init.headers,
                        body: lastBody,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel,
                        email: acc.realEmail || acc.email
                      },
                      rData,
                      logger.getTimestamp()
                    )
                  throw new Error(`Kiro Error: ${res.status}`)
                } catch (e) {
                  if (isNetworkError(e) && retry < config.rate_limit_max_retries) {
                    const d = 5000 * Math.pow(2, retry)
                    showToast(`Network error. Retrying in ${Math.ceil(d / 1000)}s...`, 'warning')
                    await sleep(d)
                    retry++
                    continue
                  }
                  throw e
                }
              }
            }
          }
        },
        methods: [
          {
            id: 'idc',
            label: 'AWS Builder ID (IDC)',
            type: 'oauth',
            authorize: async (inputs?: any) =>
              new Promise(async (resolve) => {
                const region = config.default_region
                if (inputs) {
                  const accounts: KiroIDCTokenResult[] = []
                  let startFresh = true
                  const existingAm = await AccountManager.loadFromDisk(
                    config.account_selection_strategy
                  )
                  const idcAccs = existingAm.getAccounts().filter((a) => a.authMethod === 'idc')
                  if (idcAccs.length > 0) {
                    const existingAccounts = idcAccs.map((acc, idx) => ({
                      email: acc.realEmail || acc.email,
                      index: idx
                    }))
                    startFresh = (await promptLoginMode(existingAccounts)) === 'fresh'
                  }
                  while (true) {
                    try {
                      const authData = await authorizeKiroIDC(region)
                      const { url, waitForAuth } = await startIDCAuthServer(
                        authData,
                        config.auth_server_port_start,
                        config.auth_server_port_range
                      )
                      openBrowser(url)
                      const res = await waitForAuth()
                      accounts.push(res as KiroIDCTokenResult)
                      const am = await AccountManager.loadFromDisk(
                        config.account_selection_strategy
                      )
                      if (accounts.length === 1 && startFresh)
                        am.getAccounts()
                          .filter((a) => a.authMethod === 'idc')
                          .forEach((a) => am.removeAccount(a))
                      const acc: ManagedAccount = {
                        id: generateAccountId(),
                        email: res.email,
                        authMethod: 'idc',
                        region,
                        clientId: res.clientId,
                        clientSecret: res.clientSecret,
                        refreshToken: res.refreshToken,
                        accessToken: res.accessToken,
                        expiresAt: res.expiresAt,
                        rateLimitResetTime: 0,
                        isHealthy: true
                      }
                      try {
                        const u = await fetchUsageLimits({
                          refresh: encodeRefreshToken({
                            refreshToken: res.refreshToken,
                            clientId: res.clientId,
                            clientSecret: res.clientSecret,
                            authMethod: 'idc'
                          }),
                          access: res.accessToken,
                          expires: res.expiresAt,
                          authMethod: 'idc',
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret,
                          email: res.email
                        })
                        am.updateUsage(acc.id, {
                          usedCount: u.usedCount,
                          limitCount: u.limitCount,
                          realEmail: u.email
                        })
                      } catch {}
                      am.addAccount(acc)
                      await am.saveToDisk()
                      showToast(`Account authenticated (${res.email})`, 'success')
                      if (!(await promptAddAnotherAccount(am.getAccountCount()))) break
                    } catch (e: any) {
                      showToast(`Failed: ${e.message}`, 'error')
                      break
                    }
                  }
                  const finalAm = await AccountManager.loadFromDisk(
                    config.account_selection_strategy
                  )
                  return resolve({
                    url: '',
                    instructions: `Complete (${finalAm.getAccountCount()} accounts).`,
                    method: 'auto',
                    callback: async () => ({
                      type: 'success',
                      key: finalAm.getAccounts()[0]?.accessToken
                    })
                  })
                }
                try {
                  const authData = await authorizeKiroIDC(region)
                  const { url, waitForAuth } = await startIDCAuthServer(
                    authData,
                    config.auth_server_port_start,
                    config.auth_server_port_range
                  )
                  openBrowser(url)
                  resolve({
                    url,
                    instructions: `Open: ${url}`,
                    method: 'auto',
                    callback: async () => {
                      try {
                        const res = await waitForAuth(),
                          am = await AccountManager.loadFromDisk(config.account_selection_strategy)
                        const acc: ManagedAccount = {
                          id: generateAccountId(),
                          email: res.email,
                          authMethod: 'idc',
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret,
                          refreshToken: res.refreshToken,
                          accessToken: res.accessToken,
                          expiresAt: res.expiresAt,
                          rateLimitResetTime: 0,
                          isHealthy: true
                        }
                        am.addAccount(acc)
                        await am.saveToDisk()
                        return { type: 'success', key: res.accessToken }
                      } catch (e: any) {
                        return { type: 'failed' }
                      }
                    }
                  })
                } catch (e: any) {
                  resolve({
                    url: '',
                    instructions: 'Failed',
                    method: 'auto',
                    callback: async () => ({ type: 'failed' })
                  })
                }
              })
          }
        ]
      }
    }
  }
export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
