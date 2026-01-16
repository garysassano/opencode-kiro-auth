import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { getIDCAuthHtml, getSuccessHtml, getErrorHtml } from './auth-page'
import type { KiroRegion } from './types'
import * as logger from './logger'

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
}

export function startIDCAuthServer(
  authData: IDCAuthData,
  port: number = 19847
): Promise<{ url: string; waitForAuth: () => Promise<KiroIDCTokenResult> }> {
  return new Promise((resolve, reject) => {
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
        const body = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: authData.deviceCode,
          client_id: authData.clientId,
          client_secret: authData.clientSecret
        })
        const res = await fetch(`https://oidc.${authData.region}.amazonaws.com/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        })
        const d = await res.json()
        if (res.ok) {
          const acc = d.access_token,
            ref = d.refresh_token,
            exp = Date.now() + d.expires_in * 1000
          const infoRes = await fetch('https://view.awsapps.com/api/user/info', {
            headers: { Authorization: `Bearer ${acc}` }
          })
          const info = await infoRes.json()
          const email = info.email || info.userName || 'builder-id@aws.amazon.com'
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
