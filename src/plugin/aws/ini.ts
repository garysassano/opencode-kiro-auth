export type IniData = Record<string, Record<string, string>>

export function parseIni(input: string): IniData {
  const result: IniData = {}
  let section = 'default'
  result[section] = result[section] || {}

  const lines = input.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#') || line.startsWith(';')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim()
      if (!result[section]) result[section] = {}
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key) continue
    result[section]![key] = value
  }

  return result
}
