'use strict';
/**
 * Option resolution. Precedence (highest first):
 *   1. SESSION_NAMER_* environment variables and CLAUDE_SESSION_NAMER=off
 *   2. CLAUDE_PLUGIN_OPTION_* (exported by Claude Code from the plugin userConfig)
 *   3. .session-namer.json at the repository root (only `project` and `enabled`)
 *   4. DEFAULTS
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  enabled: true,
  model: 'haiku',
  separator: ' - ',
  maxWords: 7,
  timeoutMs: 15000,
  projectSource: 'git',
  nameHeadless: false,
  projectOverride: null,
});

const LIMITS = { maxWords: [3, 12], timeoutMs: [1000, 25000] };
const REPO_FILE = '.session-namer.json';

const pick = (env, ...keys) => {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return undefined;
};

const toBool = (v, fallback) => {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
};

const toInt = (v, fallback, [min, max]) => {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function readRepoFile(repoRoot) {
  if (!repoRoot) return {};
  try {
    const raw = fs.readFileSync(path.join(repoRoot, REPO_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    if (typeof data.project === 'string' && data.project.trim()) out.projectOverride = data.project.trim();
    if (typeof data.enabled === 'boolean') out.enabled = data.enabled;
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string|null }} opts
 */
function loadConfig({ env = process.env, repoRoot = null } = {}) {
  const repo = readRepoFile(repoRoot);

  const enabledOpt = toBool(pick(env, 'SESSION_NAMER_ENABLED', 'CLAUDE_PLUGIN_OPTION_ENABLED'), repo.enabled ?? DEFAULTS.enabled);
  const killSwitch = (env.CLAUDE_SESSION_NAMER || '').trim().toLowerCase();
  const enabled = ['off', '0', 'false'].includes(killSwitch) ? false : enabledOpt;

  const projectSourceRaw = pick(env, 'SESSION_NAMER_PROJECT_SOURCE', 'CLAUDE_PLUGIN_OPTION_PROJECT_SOURCE');
  const projectSource = ['git', 'cwd'].includes(projectSourceRaw) ? projectSourceRaw : DEFAULTS.projectSource;

  return {
    enabled,
    model: pick(env, 'SESSION_NAMER_MODEL', 'CLAUDE_PLUGIN_OPTION_MODEL') || DEFAULTS.model,
    separator: pick(env, 'SESSION_NAMER_SEPARATOR', 'CLAUDE_PLUGIN_OPTION_SEPARATOR') || DEFAULTS.separator,
    maxWords: toInt(pick(env, 'SESSION_NAMER_MAX_WORDS', 'CLAUDE_PLUGIN_OPTION_MAX_WORDS'), DEFAULTS.maxWords, LIMITS.maxWords),
    timeoutMs: toInt(pick(env, 'SESSION_NAMER_TIMEOUT_MS', 'CLAUDE_PLUGIN_OPTION_TIMEOUT_MS'), DEFAULTS.timeoutMs, LIMITS.timeoutMs),
    projectSource,
    nameHeadless: toBool(pick(env, 'SESSION_NAMER_NAME_HEADLESS', 'CLAUDE_PLUGIN_OPTION_NAME_HEADLESS'), DEFAULTS.nameHeadless),
    projectOverride: repo.projectOverride ?? DEFAULTS.projectOverride,
  };
}

module.exports = { loadConfig, DEFAULTS, REPO_FILE };
