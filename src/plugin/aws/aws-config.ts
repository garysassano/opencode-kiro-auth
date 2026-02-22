import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseIni } from './ini'

export interface AwsSsoDefaults {
  startUrl: string
  ssoRegion: string
  profile: string
  source: 'aws-config'
}

function normalizeProfileSection(profile: string): string[] {
  const p = profile.trim()
  if (!p) return ['default', 'profile default']
  if (p === 'default') return ['default', 'profile default']
  return [`profile ${p}`, p]
}

function readAwsConfig(): string | null {
  try {
    const p = join(process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config'))
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

function pickSsoFields(section: Record<string, string> | undefined): {
  startUrl?: string
  ssoRegion?: string
} {
  if (!section) return {}
  const startUrl = section.sso_start_url || section.granted_sso_start_url
  const ssoRegion = section.sso_region || section.granted_sso_region
  return { startUrl, ssoRegion }
}

export function detectAwsSsoDefaults(preferredSsoRegion?: string): AwsSsoDefaults | null {
  const cfg = readAwsConfig()
  if (!cfg) return null
  const data = parseIni(cfg)

  const resolveSession = (profileSection: Record<string, string> | undefined) => {
    const sessionName = profileSection?.sso_session
    if (!sessionName) return null
    const sessionSection =
      data[`sso-session ${sessionName}`] || data[`sso_session ${sessionName}`] || undefined
    if (!sessionSection) return null
    const startUrl = sessionSection.sso_start_url
    const ssoRegion = sessionSection.sso_region
    if (startUrl && ssoRegion) return { startUrl, ssoRegion }
    return null
  }

  const explicit =
    process.env.KIRO_AWS_PROFILE || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE

  if (explicit) {
    for (const secName of normalizeProfileSection(explicit)) {
      const sec = data[secName]
      const sessionResolved = resolveSession(sec)
      const { startUrl, ssoRegion } = sessionResolved || pickSsoFields(sec)
      if (startUrl && ssoRegion) {
        return { startUrl, ssoRegion, profile: explicit, source: 'aws-config' }
      }
    }
    return null
  }

  // Collect all SSO-capable profiles.
  const candidates: AwsSsoDefaults[] = []
  for (const [sectionName, values] of Object.entries(data)) {
    if (sectionName.startsWith('profile ')) {
      const profile = sectionName.slice('profile '.length).trim()
      const sessionResolved = resolveSession(values)
      const { startUrl, ssoRegion } = sessionResolved || pickSsoFields(values)
      if (startUrl && ssoRegion)
        candidates.push({ startUrl, ssoRegion, profile, source: 'aws-config' })
    } else if (sectionName === 'default') {
      const sessionResolved = resolveSession(values)
      const { startUrl, ssoRegion } = sessionResolved || pickSsoFields(values)
      if (startUrl && ssoRegion)
        candidates.push({ startUrl, ssoRegion, profile: 'default', source: 'aws-config' })
    }
  }

  if (candidates.length === 1) return candidates[0]!

  // If the plugin has a preferred SSO region (often equals default_region),
  // try to pick defaults from the matching region when unambiguous.
  if (preferredSsoRegion) {
    const regionMatches = candidates.filter((c) => c.ssoRegion === preferredSsoRegion)
    if (regionMatches.length === 1) return regionMatches[0]!
    const uniqByRegion = new Set(regionMatches.map((c) => `${c.startUrl}|${c.ssoRegion}`))
    if (uniqByRegion.size === 1 && regionMatches.length > 0) return regionMatches[0]!
  }

  // If all candidates share the same start URL + region, pick that.
  const uniq = new Set(candidates.map((c) => `${c.startUrl}|${c.ssoRegion}`))
  if (uniq.size === 1 && candidates.length > 0) return candidates[0]!

  return null
}
