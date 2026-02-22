### Description

When connecting to a provider via the TUI `/connect` flow, OpenCode does not run the plugin’s `auth.methods[].prompts` UI before calling `authorize()`. This prevents plugins from collecting required inputs (e.g., IAM Identity Center Start URL + SSO region) and can lead to the wrong login flow being opened (e.g., AWS Builder ID email page instead of the org’s IAM Identity Center username portal).

By contrast, `opencode auth login` *does* run the plugin prompt flow correctly.

### Expected behavior
`/connect` should behave like `opencode auth login`:
- If an auth method defines `prompts`, OpenCode should display them and pass the collected `inputs` to `authorize(inputs)`.
- This should happen for both OAuth and API auth methods.

### Actual behavior
- `/connect` selects the provider/method and invokes `authorize()` with no (or incomplete) `inputs`.
- Plugins that rely on prompts to choose between multiple flows can’t do so.
- In the AWS case, it often opens the AWS Builder ID page (email prompt) because the plugin never receives an IAM Identity Center Start URL / `sso_region`.

### Evidence (code pointers)
In practice, the TUI `/connect` flow currently only prompts for values on the built-in **API key** path, not for OAuth methods.

- **TUI `/connect`** (`packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`)
  - If the auth method is `api`, it renders a `DialogPrompt` (asks for an API key) and saves it.
  - If the auth method is `oauth`, it immediately calls `sdk.client.provider.oauth.authorize({ providerID, method })` with **no `inputs`**, then proceeds with auto/code handling.
  - Link: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`

- **CLI `opencode auth login`** (`packages/opencode/src/cli/cmd/auth.ts`)
  - Iterates over `method.prompts`, collects user input, and calls the plugin’s `authorize(inputs)`.
  - Link: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/auth.ts`

Related: the OAuth authorize request currently only carries a method index (no prompt payload), which blocks passing prompt values through `/connect` without an API change.

### Why this matters (real example)
For AWS IAM Identity Center device auth, plugins typically need:
- `start_url` (Identity Center Start URL) to send users to the org-specific device page
- `idc_region` (`sso_region`) for OIDC token exchange

Without prompting, the provider may:
- fall back to a default flow (Builder ID)
- or fail, forcing users to leave the TUI and use `opencode auth login` anyway

### Repro steps (provider-agnostic)
1. Use any plugin/provider auth method that defines `auth.methods[].prompts` (e.g. `start_url` and `idc_region`) and requires those inputs to choose the correct OAuth flow.
2. Start OpenCode TUI.
3. Run `/connect` and select that provider/method.
4. Observe that OpenCode does not show the plugin’s prompts and calls `authorize()` without the required `inputs`, causing the provider to:
   - open the wrong login page (common with AWS Builder ID vs IAM Identity Center), or
   - fail and require a separate login flow outside `/connect`.
5. Run `opencode auth login` for the same provider/method.
6. Observe that OpenCode *does* show the prompts and passes `inputs` to `authorize(inputs)` as expected.

### Proposed fix
In the `/connect` flow, if the selected auth method includes `prompts`:
- Render those prompts in the TUI
- Collect `inputs`
- Call `authorize(inputs)` (or `authorize` for API methods)

### Workarounds
- Use `opencode auth login` instead of `/connect`
- Or preconfigure provider-specific defaults in config files/env vars (not always possible / not discoverable)

### Environment
- OpenCode version: `1.2.10` (adjust if different)
- OS: Linux (adjust if different)
- Example impacted scenario: AWS IAM Identity Center device auth (Start URL + SSO region prompts)


### Plugins

_No response_

### OpenCode version

1.2.10

### Steps to reproduce

_No response_

### Screenshot and/or share link

_No response_

### Operating System

_No response_

### Terminal

_No response_
