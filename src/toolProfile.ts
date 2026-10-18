import { readFileSync } from 'node:fs';
import { ASHARE_TOOL_NAMES } from './ashare/definitions.js';

/**
 * Optional tool exposure profile. Without configuration every original tool
 * is exposed exactly as before and the A-share tools stay hidden.
 *
 * - FINANCE_TOOL_PROFILE=full (default) | ashare_daily
 *     ashare_daily exposes only the A-share daily research tools.
 * - ASHARE_ENABLED=1 adds the A-share tools to the full profile.
 * - FINANCE_ENABLED_TOOLS=a,b,c restricts the exposed tools to this list.
 * - FINANCE_TOOL_CONFIG=/path/tools.json with {"profile": "...", "enabled_tools": [...]}
 *   (environment variables take precedence over the file).
 */
export interface ToolProfile {
  profile: 'full' | 'ashare_daily';
  ashareEnabled: boolean;
  allowlist?: Set<string>;
}

let cached: { key: string; value: ToolProfile } | undefined;

function readConfigFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error: any) {
    throw new Error(`无法读取工具配置文件 ${path}: ${error?.message ?? error}`);
  }
}

export function getToolProfile(): ToolProfile {
  const env = process.env;
  const key = [env.FINANCE_TOOL_PROFILE, env.ASHARE_ENABLED, env.FINANCE_ENABLED_TOOLS, env.FINANCE_TOOL_CONFIG].join('|');
  if (cached?.key === key) return cached.value;

  const file = env.FINANCE_TOOL_CONFIG?.trim() ? readConfigFile(env.FINANCE_TOOL_CONFIG.trim()) : {};
  const rawProfile = (env.FINANCE_TOOL_PROFILE?.trim() || (typeof file.profile === 'string' ? file.profile : '') || 'full').toLowerCase();
  if (rawProfile !== 'full' && rawProfile !== 'ashare_daily') {
    throw new Error(`未知的 FINANCE_TOOL_PROFILE: ${rawProfile}（可选 full、ashare_daily）`);
  }
  const listRaw = env.FINANCE_ENABLED_TOOLS?.trim()
    ? env.FINANCE_ENABLED_TOOLS.split(',')
    : Array.isArray(file.enabled_tools) ? file.enabled_tools.map(String) : [];
  const allowlist = listRaw.map(s => s.trim()).filter(Boolean);
  const profile = rawProfile as ToolProfile['profile'];
  const value: ToolProfile = {
    profile,
    ashareEnabled: profile === 'ashare_daily' || env.ASHARE_ENABLED === '1' || allowlist.some(n => ASHARE_TOOL_NAMES.has(n)),
    allowlist: allowlist.length ? new Set(allowlist) : undefined,
  };
  cached = { key, value };
  return value;
}

/** Whether a tool name passes the configured profile (credential checks are separate). */
export function isToolExposed(name: string): boolean {
  const p = getToolProfile();
  if (p.allowlist && !p.allowlist.has(name)) return false;
  if (ASHARE_TOOL_NAMES.has(name)) return p.ashareEnabled;
  return p.profile === 'full';
}
