/**
 * The API client the `.mthds` post-edit hook validates through, named for the
 * `User-Agent` contract (`docs/specs/client-identification.md`): the hook
 * identifies itself as `pipelex-mthds-check`, the registry token of the `hook`
 * surface, in front of the SDK's own `pipelex-sdk-js` token.
 */

import { PipelexApiClient } from "../client.js";
import type { AppInfo } from "../user-agent.js";
import { SDK_VERSION } from "../version.js";

/** The hook's identity — it ships inside this package, so it carries the SDK's version. */
export const HOOK_APP_INFO: AppInfo = { name: "pipelex-mthds-check", version: SDK_VERSION };

/** Build the client the hook's validate stage calls (key and base URL from the environment). */
export function createHookClient(): PipelexApiClient {
  return new PipelexApiClient({ appInfo: HOOK_APP_INFO });
}
