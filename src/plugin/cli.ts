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

export async function promptDeleteAccount(
  accounts: ExistingAccountInfo[]
): Promise<number[] | null> {
  const rl = createInterface({ input, output })
  try {
    console.log(`\nSelect account(s) to delete:`)
    for (const acc of accounts) {
      const label = acc.email || `Account ${acc.index + 1}`
      console.log(`  ${acc.index + 1}. ${label}`)
    }
    console.log(`  0. Cancel`)
    console.log('')

    while (true) {
      const answer = await rl.question('Enter account number(s) (e.g., 1,2,3 or 1): ')
      const trimmed = answer.trim()

      if (trimmed === '0') {
        return null
      }

      const parts = trimmed.split(',').map((s) => s.trim())
      const numbers: number[] = []
      let invalid = false

      for (const part of parts) {
        const num = parseInt(part, 10)
        if (isNaN(num) || num < 1 || num > accounts.length) {
          invalid = true
          break
        }
        if (!numbers.includes(num)) {
          numbers.push(num)
        }
      }

      if (invalid) {
        console.log(
          `Please enter valid numbers between 1 and ${accounts.length}, separated by commas`
        )
        continue
      }

      if (numbers.length === 0) {
        console.log(`Please enter at least one account number`)
        continue
      }

      const indices = numbers.map((n) => n - 1)
      const selectedAccounts = indices
        .map((i) => accounts[i])
        .filter((acc): acc is ExistingAccountInfo => acc !== undefined)

      if (selectedAccounts.length === 0) {
        console.log(`No valid accounts selected`)
        continue
      }

      console.log(`\nYou are about to delete ${selectedAccounts.length} account(s):`)
      for (const acc of selectedAccounts) {
        const label = acc.email || `Account ${acc.index + 1}`
        console.log(`  - ${label}`)
      }

      const confirm = await rl.question(`\nConfirm deletion? (y/n): `)
      const normalized = confirm.trim().toLowerCase()

      if (normalized === 'y' || normalized === 'yes') {
        return selectedAccounts.map((acc) => acc.index)
      }
      return null
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
