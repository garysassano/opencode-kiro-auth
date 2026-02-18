import { createServer, type Server, type ServerResponse } from 'node:http'
import { authorizeKiroIDC } from '../kiro/oauth-idc'
import { getErrorHtml, getIDCAuthHtml, getStartUrlInputHtml, getSuccessHtml } from './auth-page'
import * as logger from './logger'
import type { KiroRegion } from './types'

export interface KiroIDCTokenResult {
  email: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
  clientSecret: string
}
export interface IDCAuthData {
  verificationUrl: string
  verificationUriComplete: string
  userCode: string
  deviceCode: string
  clientId: string
  clientSecret: string
  interval: number
  expiresIn: number
  region: KiroRegion
  startUrl: string
}

async function tryPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.once('error', () => resolve(false))
    testServer.once('listening', () => {
      testServer.close()
      resolve(true)
    })
    testServer.listen(port, '127.0.0.1')
  })
}

async function findAvailablePort(startPort: number, range: number): Promise<number> {
  for (let i = 0; i < range; i++) {
    const port = startPort + i
    const available = await tryPort(port)
    if (available) return port
  }
  throw new Error(
    `No available ports in range ${startPort}-${startPort + range - 1}. Please close other applications using these ports.`
  )
}

export async function startIDCAuthServer(
  authData: IDCAuthData,
  startPort: number = 19847,
  portRange: number = 10
): Promise<{ url: string; waitForAuth: () => Promise<KiroIDCTokenResult> }> {
  return new Promise(async (resolve, reject) => {
    let port: number
    try {
      port = await findAvailablePort(startPort, portRange)
      logger.log(`Auth server will use port ${port}`)
    } catch (error) {
      logger.error('Failed to find available port', error)
      reject(error)
      return
    }

    let server: Server | null = null
    let timeoutId: any = null
    let resolver: any = null
    let rejector: any = null
    const status: any = { status: 'pending' }

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (server) server.close()
    }
    const sendHtml = (res: ServerResponse, html: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    }

    const poll = async () => {
      try {
        const body = {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: authData.deviceCode,
          clientId: authData.clientId,
          clientSecret: authData.clientSecret
        }
        const res = await fetch(`https://oidc.${authData.region}.amazonaws.com/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })

        const responseText = await res.text()
        let d: any = {}
        if (responseText) {
          try {
            d = JSON.parse(responseText)
          } catch (parseError: any) {
            logger.error(
              `Auth polling error: Failed to parse JSON (status ${res.status})`,
              parseError
            )
            throw parseError
          }
        }
        if (res.ok) {
          const acc = d.access_token || d.accessToken,
            ref = d.refresh_token || d.refreshToken,
            exp = Date.now() + (d.expires_in || d.expiresIn || 0) * 1000
          let email = 'builder-id@aws.amazon.com'
          try {
            // Derive user info URL from startUrl: replace /start with /api/user/info
            const userInfoUrl = authData.startUrl.replace(/\/start\/?$/, '/api/user/info')
            const infoRes = await fetch(userInfoUrl, {
              headers: { Authorization: `Bearer ${acc}` }
            })
            if (infoRes.ok) {
              const info = await infoRes.json()
              email = info.email || info.userName || email
            } else {
              logger.warn(
                `User info request failed with status ${infoRes.status}; using fallback email`
              )
            }
          } catch (infoError: any) {
            logger.warn(
              `Failed to fetch user info; using fallback email: ${infoError?.message || infoError}`
            )
          }
          status.status = 'success'
          if (resolver)
            resolver({
              email,
              accessToken: acc,
              refreshToken: ref,
              expiresAt: exp,
              clientId: authData.clientId,
              clientSecret: authData.clientSecret
            })
          setTimeout(cleanup, 2000)
        } else if (d.error === 'authorization_pending') {
          setTimeout(poll, authData.interval * 1000)
        } else {
          status.status = 'failed'
          status.error = d.error_description || d.error
          logger.error(`Auth polling failed a: ${status.error}`)
          if (rejector) rejector(new Error(status.error))
          setTimeout(cleanup, 2000)
        }
      } catch (e: any) {
        status.status = 'failed'
        status.error = e.message
        logger.error(`Auth polling error b: ${e.message}`, e)
        if (rejector) rejector(e)
        setTimeout(cleanup, 2000)
      }
    }

    server = createServer((req, res) => {
      const u = req.url || ''
      if (u === '/' || u.startsWith('/?'))
        sendHtml(
          res,
          getIDCAuthHtml(
            authData.verificationUriComplete,
            authData.userCode,
            `http://127.0.0.1:${port}/status`
          )
        )
      else if (u === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(status))
      } else if (u === '/success') sendHtml(res, getSuccessHtml())
      else if (u === '/error') sendHtml(res, getErrorHtml(status.error || 'Failed'))
      else {
        res.writeHead(404)
        res.end()
      }
    })

    server.on('error', (e) => {
      logger.error(`Auth server error on port ${port}`, e)
      cleanup()
      reject(e)
    })
    server.listen(port, '127.0.0.1', () => {
      timeoutId = setTimeout(() => {
        status.status = 'timeout'
        logger.warn('Auth timeout waiting for authorization')
        if (rejector) rejector(new Error('Timeout'))
        cleanup()
      }, 900000)
      poll()
      resolve({
        url: `http://127.0.0.1:${port}`,
        waitForAuth: () =>
          new Promise((rv, rj) => {
            resolver = rv
            rejector = rj
          })
      })
    })
  })
}

/**
 * Starts a local auth server that first shows a Start URL input page.
 * After the user submits, it calls authorizeKiroIDC internally and transitions
 * to the verification code page — no need to call authorizeKiroIDC beforehand.
 */
export async function startIDCAuthServerWithInput(
  region: KiroRegion,
  defaultStartUrl: string | undefined,
  startPort: number = 19847,
  portRange: number = 10
): Promise<{ url: string; waitForAuth: () => Promise<KiroIDCTokenResult> }> {
  return new Promise(async (resolve, reject) => {
    let port: number
    try {
      port = await findAvailablePort(startPort, portRange)
      logger.log(`Auth server (with input) will use port ${port}`)
    } catch (error) {
      logger.error('Failed to find available port', error)
      reject(error)
      return
    }

    let server: Server | null = null
    let timeoutId: any = null
    let resolver: any = null
    let rejector: any = null
    const status: any = { status: 'pending' }
    // authData is populated after the user submits the start URL form
    let authData: IDCAuthData | null = null

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (server) server.close()
    }

    const sendHtml = (res: ServerResponse, html: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    }

    const sendJson = (res: ServerResponse, code: number, data: object) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    const poll = async (data: IDCAuthData) => {
      try {
        const body = {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: data.deviceCode,
          clientId: data.clientId,
          clientSecret: data.clientSecret
        }
        const res = await fetch(`https://oidc.${data.region}.amazonaws.com/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        const responseText = await res.text()
        let d: any = {}
        if (responseText) {
          try {
            d = JSON.parse(responseText)
          } catch (parseError: any) {
            logger.error(
              `Auth polling error: Failed to parse JSON (status ${res.status})`,
              parseError
            )
            throw parseError
          }
        }
        if (res.ok) {
          const acc = d.access_token || d.accessToken,
            ref = d.refresh_token || d.refreshToken,
            exp = Date.now() + (d.expires_in || d.expiresIn || 0) * 1000
          let email = 'builder-id@aws.amazon.com'
          try {
            const userInfoUrl = data.startUrl.replace(/\/start\/?$/, '/api/user/info')
            const infoRes = await fetch(userInfoUrl, {
              headers: { Authorization: `Bearer ${acc}` }
            })
            if (infoRes.ok) {
              const info = await infoRes.json()
              email = info.email || info.userName || email
            } else {
              logger.warn(
                `User info request failed with status ${infoRes.status}; using fallback email`
              )
            }
          } catch (infoError: any) {
            logger.warn(
              `Failed to fetch user info; using fallback email: ${infoError?.message || infoError}`
            )
          }
          status.status = 'success'
          if (resolver)
            resolver({
              email,
              accessToken: acc,
              refreshToken: ref,
              expiresAt: exp,
              clientId: data.clientId,
              clientSecret: data.clientSecret
            })
          setTimeout(cleanup, 2000)
        } else if (d.error === 'authorization_pending') {
          setTimeout(() => poll(data), data.interval * 1000)
        } else {
          status.status = 'failed'
          status.error = d.error_description || d.error
          logger.error(`Auth polling failed: ${status.error}`)
          if (rejector) rejector(new Error(status.error))
          setTimeout(cleanup, 2000)
        }
      } catch (e: any) {
        status.status = 'failed'
        status.error = e.message
        logger.error(`Auth polling error: ${e.message}`, e)
        if (rejector) rejector(e)
        setTimeout(cleanup, 2000)
      }
    }

    server = createServer(async (req, res) => {
      const u = req.url || ''

      // Step 1: Show start URL input page
      if (u === '/' || u === '') {
        sendHtml(res, getStartUrlInputHtml(defaultStartUrl || '', `http://127.0.0.1:${port}/setup`))
        return
      }

      // Step 2: Receive start URL, call authorizeKiroIDC, return auth info to browser
      if (u === '/setup' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', async () => {
          try {
            const { startUrl } = JSON.parse(body)
            const effectiveStartUrl = startUrl || undefined
            const data = await authorizeKiroIDC(region, effectiveStartUrl)
            authData = data
            // Start polling now that we have device code
            poll(authData)
            sendJson(res, 200, {
              userCode: data.userCode,
              verificationUriComplete: data.verificationUriComplete
            })
          } catch (e: any) {
            logger.error('authorizeKiroIDC failed', e)
            sendJson(res, 500, { error: e.message || 'Failed to initialize authentication' })
          }
        })
        return
      }

      // Step 3: Show verification code page (browser redirects here after /setup)
      if (u.startsWith('/auth')) {
        const params = new URL(u, `http://127.0.0.1:${port}`).searchParams
        const code = params.get('code') || ''
        const verUrl = params.get('url') || ''
        sendHtml(res, getIDCAuthHtml(verUrl, code, `http://127.0.0.1:${port}/status`))
        return
      }

      if (u === '/status') {
        sendJson(res, 200, status)
        return
      }

      if (u === '/success') {
        sendHtml(res, getSuccessHtml())
        return
      }
      if (u.startsWith('/error')) {
        sendHtml(res, getErrorHtml(status.error || 'Failed'))
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.on('error', (e) => {
      logger.error(`Auth server error on port ${port}`, e)
      cleanup()
      reject(e)
    })

    server.listen(port, '127.0.0.1', () => {
      timeoutId = setTimeout(() => {
        status.status = 'timeout'
        logger.warn('Auth timeout waiting for authorization')
        if (rejector) rejector(new Error('Timeout'))
        cleanup()
      }, 900000)

      resolve({
        url: `http://127.0.0.1:${port}`,
        waitForAuth: () =>
          new Promise((rv, rj) => {
            resolver = rv
            rejector = rj
          })
      })
    })
  })
}
