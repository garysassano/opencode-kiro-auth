import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`Add another account? (${currentCount} added) (y/n): `)
    const normalized = answer.trim().toLowerCase()
    return normalized === 'y' || normalized === 'yes'
  } finally {
    rl.close()
  }
}

export async function promptDeleteAccount(accounts: ExistingAccountInfo[]): Promise<number | null> {
  const rl = createInterface({ input, output })
  try {
    console.log(`\nSelect account to delete:`)
    for (const acc of accounts) {
      const label = acc.email || `Account ${acc.index + 1}`
      console.log(`  ${acc.index + 1}. ${label}`)
    }
    console.log(`  0. Cancel`)
    console.log('')

    while (true) {
      const answer = await rl.question('Enter account number: ')
      const num = parseInt(answer.trim(), 10)

      if (num === 0) {
        return null
      }

      if (num >= 1 && num <= accounts.length) {
        const selected = accounts[num - 1]
        const label = selected?.email || `Account ${num}`
        const confirm = await rl.question(`Delete "${label}"? (y/n): `)
        const normalized = confirm.trim().toLowerCase()

        if (normalized === 'y' || normalized === 'yes') {
          return selected?.index ?? null
        }
        return null
      }

      console.log(`Please enter a number between 0 and ${accounts.length}`)
    }
  } finally {
    rl.close()
  }
}

export type LoginMode = 'add' | 'fresh' | 'delete'

export interface ExistingAccountInfo {
  email?: string
  index: number
}

export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMode> {
  const rl = createInterface({ input, output })
  try {
    console.log(`\n${existingAccounts.length} account(s) saved:`)
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`
      console.log(`  ${acc.index + 1}. ${label}`)
    }
    console.log('')

    while (true) {
      const answer = await rl.question(
        '(a)dd new account(s), (f)resh start, or (d)elete account? [a/f/d]: '
      )
      const normalized = answer.trim().toLowerCase()

      if (normalized === 'a' || normalized === 'add') {
        return 'add'
      }
      if (normalized === 'f' || normalized === 'fresh') {
        return 'fresh'
      }
      if (normalized === 'd' || normalized === 'delete') {
        return 'delete'
      }

      console.log("Please enter 'a' to add accounts, 'f' to start fresh, or 'd' to delete account.")
    }
  } finally {
    rl.close()
  }
}
