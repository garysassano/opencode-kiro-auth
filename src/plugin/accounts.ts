import { randomBytes } from 'node:crypto';
import { loadAccounts, saveAccounts } from './storage';
import type { 
  ManagedAccount, 
  AccountMetadata, 
  AccountStorage, 
  AccountSelectionStrategy,
  KiroAuthDetails,
  RefreshParts,
} from './types';
import * as logger from './logger';
import { KIRO_CONSTANTS } from '../constants';
import { encodeRefreshToken, decodeRefreshToken, accessTokenExpired } from '../kiro/auth';

export function generateAccountId(): string {
  return randomBytes(16).toString('hex');
}

export function isAccountAvailable(account: ManagedAccount): boolean {
  const now = Date.now();
  
  if (!account.isHealthy) {
    if (account.recoveryTime && now >= account.recoveryTime) {
      return true;
    }
    return false;
  }
  
  if (account.rateLimitResetTime && now < account.rateLimitResetTime) {
    return false;
  }
  
  return true;
}

export class AccountManager {
  private accounts: ManagedAccount[];
  private cursor: number;
  private strategy: AccountSelectionStrategy;
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  constructor(accounts: ManagedAccount[], strategy: AccountSelectionStrategy = 'sticky') {
    this.accounts = accounts;
    this.cursor = 0;
    this.strategy = strategy;
  }

  static async loadFromDisk(strategy?: AccountSelectionStrategy): Promise<AccountManager> {
    const storage = await loadAccounts();
    const accounts: ManagedAccount[] = storage.accounts.map((meta) => ({
      id: meta.id,
      email: meta.email,
      authMethod: meta.authMethod,
      region: meta.region || KIRO_CONSTANTS.DEFAULT_REGION,
      profileArn: meta.profileArn,
      clientId: meta.clientId,
      clientSecret: meta.clientSecret,
      refreshToken: meta.refreshToken,
      accessToken: meta.accessToken,
      expiresAt: meta.expiresAt,
      rateLimitResetTime: meta.rateLimitResetTime,
      isHealthy: meta.isHealthy,
      unhealthyReason: meta.unhealthyReason,
      recoveryTime: meta.recoveryTime,
      usedCount: meta.usedCount,
      limitCount: meta.limitCount,
    }));
    
    return new AccountManager(accounts, strategy || 'sticky');
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = Date.now();
    if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
      return false;
    }
    return true;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = Date.now();
  }

  getMinWaitTime(): number {
    const now = Date.now();
    const waitTimes = this.accounts
      .map(a => (a.rateLimitResetTime || 0) - now)
      .filter(t => t > 0);
    
    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getCurrentOrNext(): ManagedAccount | null {
    const now = Date.now();
    
    const availableAccounts = this.accounts.filter((account) => {
      if (!account.isHealthy) {
        if (account.recoveryTime && now >= account.recoveryTime) {
          account.isHealthy = true;
          delete account.unhealthyReason;
          delete account.recoveryTime;
          return true;
        }
        return false;
      }
      
      if (account.rateLimitResetTime && now < account.rateLimitResetTime) {
        return false;
      }
      
      return true;
    });
    
    if (availableAccounts.length === 0) {
      return null;
    }
    
    if (this.strategy === 'sticky') {
      const currentAccount = this.accounts[this.cursor];
      if (currentAccount && isAccountAvailable(currentAccount)) {
        currentAccount.lastUsed = now;
        currentAccount.usedCount = (currentAccount.usedCount || 0) + 1;
        return currentAccount;
      }
      
      const nextAvailable = availableAccounts[0];
      if (nextAvailable) {
        this.cursor = this.accounts.indexOf(nextAvailable);
        nextAvailable.lastUsed = now;
        nextAvailable.usedCount = (nextAvailable.usedCount || 0) + 1;
        return nextAvailable;
      }
      
      return null;
    }
    
    if (this.strategy === 'round-robin') {
      const account = availableAccounts[this.cursor % availableAccounts.length];
      if (account) {
        this.cursor = (this.cursor + 1) % availableAccounts.length;
        account.lastUsed = now;
        account.usedCount = (account.usedCount || 0) + 1;
        return account;
      }
      return null;
    }
    
    if (this.strategy === 'lowest-usage') {
      const sorted = [...availableAccounts].sort((a, b) => {
        const usageA = a.usedCount || 0;
        const usageB = b.usedCount || 0;
        if (usageA !== usageB) return usageA - usageB;
        
        const lastA = a.lastUsed || 0;
        const lastB = b.lastUsed || 0;
        return lastA - lastB;
      });
      
      const selected = sorted[0];
      if (selected) {
        selected.lastUsed = now;
        selected.usedCount = (selected.usedCount || 0) + 1;
        this.cursor = this.accounts.indexOf(selected);
        return selected;
      }
      return null;
    }
    
    return null;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.rateLimitResetTime = Date.now() + retryAfterMs;
      }
    }
  }

  markUnhealthy(account: ManagedAccount, reason: string, recoveryTime?: number): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.isHealthy = false;
        acc.unhealthyReason = reason;
        if (recoveryTime) {
          acc.recoveryTime = recoveryTime;
        }
      }
    }
  }

  markHealthy(account: ManagedAccount): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.isHealthy = true;
        delete acc.unhealthyReason;
        delete acc.recoveryTime;
      }
    }
  }

  updateFromAuth(account: ManagedAccount, auth: KiroAuthDetails): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.accessToken = auth.access;
        acc.expiresAt = auth.expires;
        acc.lastUsed = Date.now();
        
        const parts = decodeRefreshToken(auth.refresh);
        acc.refreshToken = parts.refreshToken;
        if (parts.profileArn) {
          acc.profileArn = parts.profileArn;
        }
        if (parts.clientId) {
          acc.clientId = parts.clientId;
        }
      }
    }
  }

  addAccount(account: ManagedAccount): void {
    if (!account.id) {
      account.id = generateAccountId();
    }
    this.accounts.push(account);
  }

  removeAccount(account: ManagedAccount): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      this.accounts.splice(accountIndex, 1);
      
      if (this.cursor >= this.accounts.length && this.accounts.length > 0) {
        this.cursor = this.accounts.length - 1;
      } else if (this.accounts.length === 0) {
        this.cursor = 0;
      }
    }
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    const metadata: AccountMetadata[] = this.accounts.map((account) => ({
      id: account.id,
      email: account.email,
      authMethod: account.authMethod,
      region: account.region,
      profileArn: account.profileArn,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      rateLimitResetTime: account.rateLimitResetTime,
      isHealthy: account.isHealthy,
      unhealthyReason: account.unhealthyReason,
      recoveryTime: account.recoveryTime,
      usedCount: account.usedCount,
      limitCount: account.limitCount,
    }));
    
    const storage: AccountStorage = {
      version: 1,
      accounts: metadata,
      activeIndex: this.cursor,
    };
    
    await saveAccounts(storage);
  }

  toAuthDetails(account: ManagedAccount): KiroAuthDetails {
    const parts: RefreshParts = {
      refreshToken: account.refreshToken,
      profileArn: account.profileArn,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      authMethod: account.authMethod,
    };
    
    return {
      refresh: encodeRefreshToken(parts),
      access: account.accessToken,
      expires: account.expiresAt,
      authMethod: account.authMethod,
      region: account.region || KIRO_CONSTANTS.DEFAULT_REGION,
      profileArn: account.profileArn,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      email: account.email,
    };
  }
}
