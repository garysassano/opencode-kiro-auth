
import { loadConfig } from './plugin/config';
import { AccountManager, generateAccountId } from './plugin/accounts';
import { createProactiveRefreshQueue } from './plugin/refresh-queue';
import { createSessionRecoveryHook } from './plugin/recovery';
import { accessTokenExpired, decodeRefreshToken, encodeRefreshToken } from './kiro/auth';
import { refreshAccessToken } from './plugin/token';
import { transformToCodeWhisperer } from './plugin/request';
import { parseEventStream } from './plugin/response';
import { transformKiroStream } from './plugin/streaming';
import { fetchUsageLimits, calculateRecoveryTime } from './plugin/usage';
import { updateAccountQuota } from './plugin/quota';
import { authorizeKiroIDC } from './kiro/oauth-idc';
import { startIDCAuthServer } from './plugin/server';
import { KiroTokenRefreshError } from './plugin/errors';
import type { ManagedAccount, KiroAuthDetails } from './plugin/types';
import { KIRO_CONSTANTS } from './constants';

const KIRO_PROVIDER_ID = 'kiro';
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('econnreset') ||
           message.includes('etimedout') ||
           message.includes('enotfound') ||
           message.includes('network') ||
           message.includes('fetch failed');
  }
  return false;
}

function extractModelFromUrl(url: string): string | null {
  const match = url.match(/models\/([^/:]+)/);
  return match?.[1] || null;
}

export const createKiroPlugin = (providerId: string) => async (
  { client, directory }: any
): Promise<any> => {
  const config = loadConfig(directory);

  const sessionRecovery = createSessionRecoveryHook(
    config.session_recovery,
    config.auto_resume
  );

  return {
    event: async (event: any) => {
      if (event.type === 'session.error') {
        await sessionRecovery.handleSessionError(event.error, event.sessionId);
      }
    },
    auth: {
      provider: providerId,
      loader: async (getAuth: any, provider: any) => {
        const auth = await getAuth();

        const accountManager = await AccountManager.loadFromDisk(
          config.account_selection_strategy
        );

        const refreshQueue = createProactiveRefreshQueue({
          enabled: config.proactive_token_refresh,
          checkIntervalSeconds: config.token_refresh_interval_seconds,
          bufferSeconds: config.token_refresh_buffer_seconds,
        });
        refreshQueue.setAccountManager(accountManager);
        refreshQueue.start();

        return {
          apiKey: '',
          baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace('{{region}}', config.default_region || 'us-east-1'),
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

            if (!KIRO_API_PATTERN.test(url)) {
              return fetch(input, init);
            }

            const body = init?.body ? JSON.parse(init.body as string) : {};
            const model = extractModelFromUrl(url) || body.model || 'claude-opus-4-5';
            
            const isThinkingModel = model.endsWith('-thinking');
            const providerOptions = body.providerOptions || {};
            const thinkingConfig = providerOptions.thinkingConfig;
            const thinkingEnabled = isThinkingModel || !!thinkingConfig;
            const thinkingBudget = thinkingConfig?.thinkingBudget || config.thinking_budget_tokens;

            const rateLimitStateByAccount = new Map<string, { consecutive429: number; lastAt: number }>();
            const RATE_LIMIT_DEDUP_WINDOW_MS = 2000;

            const showToast = async (message: string, variant: 'info' | 'warning' | 'success' | 'error') => {
              try {
                await client.tui.showToast({ body: { message, variant } });
              } catch {}
            };

            let retryCount = 0;
            const maxRetries = config.rate_limit_max_retries;

            while (true) {
              const accountCount = accountManager.getAccountCount();
              if (accountCount === 0) throw new Error('No available Kiro accounts. Run `opencode auth login`.');

              const account = accountManager.getCurrentOrNext();
              
              if (!account) {
                const waitMs = accountManager.getMinWaitTime() || 60000;
                await showToast(`All accounts rate-limited. Waiting ${Math.ceil(waitMs/1000)}s...`, 'warning');
                await sleep(waitMs);
                continue;
              }

              const accountIndex = accountManager.getAccounts().indexOf(account);
              if (accountCount > 1 && accountManager.shouldShowAccountToast(accountIndex)) {
                await showToast(`Using ${account.email} (${accountIndex + 1}/${accountCount})`, 'info');
                accountManager.markToastShown(accountIndex);
              }

              const authDetails = accountManager.toAuthDetails(account);

              if (accessTokenExpired(authDetails)) {
                try {
                  const refreshed = await refreshAccessToken(authDetails);
                  accountManager.updateFromAuth(account, refreshed);
                  await accountManager.saveToDisk();
                } catch (error) {
                  if (error instanceof KiroTokenRefreshError && error.code === 'invalid_grant') {
                    accountManager.removeAccount(account);
                    await accountManager.saveToDisk();
                    continue;
                  }
                  throw error;
                }
              }

              const prepared = transformToCodeWhisperer(
                url,
                init?.body as string,
                model,
                accountManager.toAuthDetails(account),
                thinkingEnabled,
                thinkingBudget
              );

              try {
                const response = await fetch(prepared.url, prepared.init);

                if (response.ok) {
                  if (config.usage_tracking_enabled) {
                    fetchUsageLimits(accountManager.toAuthDetails(account))
                      .then(usage => {
                        updateAccountQuota(account, usage);
                        accountManager.saveToDisk();
                      }).catch(() => {});
                  }

                  if (prepared.streaming) {
                    const stream = transformKiroStream(response, model, prepared.conversationId);
                    return new Response(
                      new ReadableStream({
                        async start(controller) {
                          try {
                            for await (const event of stream) {
                              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
                            }
                            controller.close();
                          } catch (error) {
                            controller.error(error);
                          }
                        }
                      }),
                      {
                        headers: {
                          'Content-Type': 'text/event-stream',
                          'Cache-Control': 'no-cache',
                          'Connection': 'keep-alive',
                        }
                      }
                    );
                  } else {
                    const text = await response.text();
                    const parsed = parseEventStream(text);
                    const openaiResponse: any = {
                      id: prepared.conversationId,
                      object: 'chat.completion',
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [
                        {
                          index: 0,
                          message: { role: 'assistant', content: parsed.content },
                          finish_reason: parsed.stopReason === 'tool_use' ? 'tool_calls' : 'stop',
                        }
                      ],
                      usage: {
                        prompt_tokens: parsed.inputTokens || 0,
                        completion_tokens: parsed.outputTokens || 0,
                        total_tokens: (parsed.inputTokens || 0) + (parsed.outputTokens || 0),
                      },
                    };

                    if (parsed.toolCalls.length > 0) {
                      openaiResponse.choices[0].message.tool_calls = parsed.toolCalls.map((tc) => ({
                        id: tc.toolUseId,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                        },
                      }));
                    }

                    return new Response(JSON.stringify(openaiResponse), {
                      headers: { 'Content-Type': 'application/json' }
                    });
                  }
                }

                const status = response.status;
                if (status === 401 && retryCount < maxRetries) {
                  const refreshed = await refreshAccessToken(authDetails);
                  accountManager.updateFromAuth(account, refreshed);
                  await accountManager.saveToDisk();
                  retryCount++;
                  continue;
                }

                if (status === 429) {
                  const retryAfter = parseInt(response.headers.get('retry-after') || '60') * 1000;
                  const now = Date.now();
                  const state = rateLimitStateByAccount.get(account.id) || { consecutive429: 0, lastAt: 0 };
                  
                  if (now - state.lastAt > RATE_LIMIT_DEDUP_WINDOW_MS) {
                    state.consecutive429++;
                    state.lastAt = now;
                    rateLimitStateByAccount.set(account.id, state);
                  }

                  accountManager.markRateLimited(account, retryAfter);
                  await accountManager.saveToDisk();

                  if (accountCount > 1) {
                    await showToast(`Rate limited on ${account.email}. Switching account...`, 'warning');
                    continue;
                  } else {
                    const backoff = Math.min(1000 * Math.pow(2, state.consecutive429 - 1), 60000);
                    await showToast(`Rate limited. Retrying in ${Math.ceil(backoff/1000)}s...`, 'warning');
                    await sleep(backoff);
                    continue;
                  }
                }

                if ((status === 402 || status === 403) && accountCount > 1) {
                  accountManager.markUnhealthy(account, status === 402 ? 'Quota exhausted' : 'Forbidden');
                  await accountManager.saveToDisk();
                  continue;
                }

                throw new Error(`Kiro API error: ${status}`);

              } catch (error) {
                if (isNetworkError(error) && retryCount < maxRetries) {
                  const delay = config.rate_limit_retry_delay_ms * Math.pow(2, retryCount);
                  await showToast(`Network error. Retrying in ${Math.ceil(delay/1000)}s...`, 'warning');
                  await sleep(delay);
                  retryCount++;
                  continue;
                }
                throw error;
              }
            }
          }
        };
      },
      methods: [
        {
          id: 'idc',
          label: 'AWS Builder ID (IDC)',
          type: 'oauth',
          authorize: async () => {
            return new Promise(async (resolve) => {
              const region = config.default_region;
              
              const authData = await authorizeKiroIDC(region);
              
              const { url, waitForAuth } = await startIDCAuthServer(authData);
              
              resolve({
                url,
                instructions: 'Opening browser for AWS Builder ID authentication...',
                method: 'auto',
                callback: async () => {
                  try {
                    const result = await waitForAuth();
                    
                    const accountManager = await AccountManager.loadFromDisk(
                      config.account_selection_strategy
                    );
                    
                    const account: ManagedAccount = {
                      id: generateAccountId(),
                      email: result.email,
                      authMethod: 'idc',
                      region,
                      clientId: result.clientId,
                      clientSecret: result.clientSecret,
                      refreshToken: result.refreshToken,
                      accessToken: result.accessToken,
                      expiresAt: result.expiresAt,
                      rateLimitResetTime: 0,
                      isHealthy: true,
                    };
                    
                    accountManager.addAccount(account);
                    await accountManager.saveToDisk();
                    
                    return { type: 'success', key: result.accessToken };
                  } catch (error) {
                    return { type: 'failed' };
                  }
                }
              });
            });
          }
        }
      ]
    }
  };
};

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID);
