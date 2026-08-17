import { ApiCredentialSource, getConfiguredApiSources } from './config.js';

export type ToolSource = ApiCredentialSource | 'public' | 'local';

/**
 * Public/local tools remain available without credentials. Once a credential
 * scope exists, only tools backed by that scope are advertised.
 */
export function getActiveToolSources(): Set<ToolSource> {
  const apiSources = getConfiguredApiSources();
  if (apiSources.length > 0) return new Set(apiSources);
  return new Set<ToolSource>(['public', 'local']);
}

export function isToolSourceAvailable(requiredSources: readonly ToolSource[]): boolean {
  const activeSources = getActiveToolSources();
  return requiredSources.some(source => activeSources.has(source));
}
