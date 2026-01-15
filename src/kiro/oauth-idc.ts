import type { KiroRegion } from '../plugin/types';
import { KIRO_AUTH_SERVICE, KIRO_CONSTANTS, buildUrl, normalizeRegion } from '../constants';

export interface KiroIDCAuthorization {
  verificationUrl: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  clientId: string;
  clientSecret: string;
  interval: number;
  expiresIn: number;
  region: KiroRegion;
}

export interface KiroIDCTokenResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email: string;
  clientId: string;
  clientSecret: string;
  region: KiroRegion;
  authMethod: 'idc';
}

export async function authorizeKiroIDC(region?: KiroRegion): Promise<KiroIDCAuthorization> {
  const effectiveRegion = normalizeRegion(region);
  
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion);
  
  const registerResponse = await fetch(`${ssoOIDCEndpoint}/client/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      clientName: 'Kiro IDE',
      clientType: 'public',
      scopes: KIRO_AUTH_SERVICE.SCOPES,
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    }),
  });
  
  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => '');
    throw new Error(`Client registration failed: ${registerResponse.status} ${errorText}`);
  }
  
  const registerData = await registerResponse.json();
  const { clientId, clientSecret } = registerData;
  
  if (!clientId || !clientSecret) {
    throw new Error('Client registration response missing clientId or clientSecret');
  }
  
  const deviceAuthResponse = await fetch(`${ssoOIDCEndpoint}/device_authorization`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: KIRO_AUTH_SERVICE.BUILDER_ID_START_URL,
    }),
  });
  
  if (!deviceAuthResponse.ok) {
    const errorText = await deviceAuthResponse.text().catch(() => '');
    throw new Error(`Device authorization failed: ${deviceAuthResponse.status} ${errorText}`);
  }
  
  const deviceAuthData = await deviceAuthResponse.json();
  
  const {
    verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    interval = 5,
    expiresIn = 600,
  } = deviceAuthData;
  
  if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) {
    throw new Error('Device authorization response missing required fields');
  }
  
  return {
    verificationUrl: verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    clientId,
    clientSecret,
    interval,
    expiresIn,
    region: effectiveRegion,
  };
}

export async function pollKiroIDCToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  region: KiroRegion
): Promise<KiroIDCTokenResult> {
  if (!clientId || !clientSecret || !deviceCode) {
    throw new Error('Missing required parameters for token polling');
  }
  
  const effectiveRegion = normalizeRegion(region);
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion);
  
  const maxAttempts = Math.floor(expiresIn / interval);
  let currentInterval = interval * 1000;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    await new Promise(resolve => setTimeout(resolve, currentInterval));
    
    try {
      const tokenResponse = await fetch(`${ssoOIDCEndpoint}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': KIRO_CONSTANTS.USER_AGENT,
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      
      const tokenData = await tokenResponse.json();
      
      if (tokenData.error) {
        const errorType = tokenData.error;
        
        if (errorType === 'authorization_pending') {
          continue;
        }
        
        if (errorType === 'slow_down') {
          currentInterval += 5000;
          continue;
        }
        
        if (errorType === 'expired_token') {
          throw new Error('Device code has expired. Please restart the authorization process.');
        }
        
        if (errorType === 'access_denied') {
          throw new Error('Authorization was denied by the user.');
        }
        
        throw new Error(`Token polling failed: ${errorType} - ${tokenData.error_description || ''}`);
      }
      
      if (tokenData.accessToken && tokenData.refreshToken) {
        const expiresInSeconds = tokenData.expiresIn || 3600;
        const expiresAt = Date.now() + expiresInSeconds * 1000;
        
        return {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
    expiresAt,
          email: 'builder-id@aws.amazon.com',
          clientId,
          clientSecret,
          region: effectiveRegion,
          authMethod: 'idc',
        };
      }
      
      if (!tokenResponse.ok) {
        throw new Error(`Token request failed with status: ${tokenResponse.status}`);
      }
      
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes('expired') ||
        error.message.includes('denied') ||
        error.message.includes('failed')
      )) {
        throw error;
      }
      
      if (attempts >= maxAttempts) {
        throw new Error(`Token polling failed after ${attempts} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }
  
  throw new Error('Token polling timed out. Authorization may have expired.');
}
