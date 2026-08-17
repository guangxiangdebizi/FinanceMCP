import { DataSourceId, getConfiguredCredentialSources } from './config.js';

export type ToolSource = DataSourceId | 'web' | 'local';

/**
 * With no credentials, only public/local capabilities are advertised. Once a
 * credential scope exists, the visible set is limited to that scope.
 */
export function getActiveToolSources(): Set<ToolSource> {
  const credentialSources = getConfiguredCredentialSources();
  if (credentialSources.length > 0) return new Set(credentialSources);
  return new Set<ToolSource>(['binance', 'web', 'local']);
}

export function isToolSourceAvailable(requiredSources: readonly ToolSource[]): boolean {
  const activeSources = getActiveToolSources();
  return requiredSources.some(source => activeSources.has(source));
}
