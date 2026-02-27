# Fix IAM Identity Center login (remove local auth server) + clarify `/connect` limitation

## Summary

The current IAM Identity Center (SSO/IDC) auth flow in this plugin relies on spinning up a local HTTP server + frontend callback flow. That approach is fragile (port conflicts, callback failures, browser issues) and it also tends to open the **AWS Builder ID** login experience even when the user provides an **IAM Identity Center Start URL** (which should route to the org username login page instead).

This change replaces that local-server flow with the standard **AWS SSO OIDC device authorization flow** (register client → start device authorization → poll token), and opens the **AWS portal device page** directly when a Start URL is provided.

## Before

- IAM Identity Center login used a local server + browser callback workflow.
- `/connect` (TUI) would often route users into the **Builder ID** login page (email prompt), even when they intended to use an **Identity Center Start URL** (username prompt).
- Users could hit `403`/AccessDenied when calling the Q Developer / CodeWhisperer endpoints because `profileArn` wasn’t sent.
- Lots of noisy toast notifications while chatting (usage + account switching).

## After

- IAM Identity Center auth uses the standard device flow:
  - calls AWS SSO OIDC to get `device_code` + `user_code`
  - opens the verification URL
  - polls until tokens are issued
  - stores tokens in `~/.config/opencode/kiro.db`
- If an Identity Center Start URL is provided, the plugin opens:
  - `https://YOUR_START_URL/start/#/device?user_code=...`
  - (this correctly routes to the org sign-in experience instead of the Builder ID email page)
- Adds `idc_region` (SSO OIDC region) and persists it as `oidc_region` in the plugin DB so refresh uses the right OIDC endpoint.
- Adds/forwards `profileArn` (when available) to the `getUsageLimits` call and the request payload, which fixes common `403` issues for Identity Center users.
- Removes noisy toast popups (usage + account switching).

## Login UX / Known OpenCode limitation

This plugin supports two flows:

1. **AWS Builder ID** (no Start URL)
   - Works via both `/connect` and `opencode auth login`.

2. **IAM Identity Center** (custom Start URL)
   - **Use `opencode auth login`** (recommended), because it can prompt for:
     - `idc_start_url`
     - `idc_region` (`sso_region`)
   - `/connect` currently cannot collect plugin-specific prompts for OAuth methods, so it can’t ask for Start URL/region and may fall back to Builder ID.

Workaround (until OpenCode supports OAuth prompts in `/connect`):

- Preconfigure defaults in `~/.config/opencode/kiro.json`:
  - `idc_start_url`
  - `idc_region`
  - optionally `idc_profile_arn` if you hit `403`

## How to reproduce / test

1. Run `opencode auth login` → provider `kiro`.
2. Enter your Identity Center Start URL (example): `https://your-company.awsapps.com/start`
3. Enter your `sso_region` (example): `eu-central-1`
4. Confirm the browser opens `https://your-company.awsapps.com/start/#/device?user_code=...`
5. Approve the device code and confirm OpenCode reports login success.
6. Send a chat request and verify it succeeds without `403`.

## Notes

- If you still hit `403` with Identity Center, it usually means the Q Developer / CodeWhisperer API requires a `profileArn`.
  - The plugin can auto-detect this from `kiro-cli` (if installed and you’ve selected a profile once via `kiro-cli profile`).
  - Or you can set `idc_profile_arn` in `~/.config/opencode/kiro.json`.

