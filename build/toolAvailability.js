import { getConfiguredApiSources } from './config.js';
/**
 * Public/local tools remain available without credentials. Once a credential
 * scope exists, only tools backed by that scope are advertised.
 */
export function getActiveToolSources() {
    const apiSources = getConfiguredApiSources();
    if (apiSources.length > 0)
        return new Set(apiSources);
    return new Set(['public', 'local']);
}
export function isToolSourceAvailable(requiredSources) {
    const activeSources = getActiveToolSources();
    return requiredSources.some(source => activeSources.has(source));
}
