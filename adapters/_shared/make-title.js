'use strict';
/**
 * Harness-neutral "<project> - <topic>" builder on top of lib/: options,
 * project resolution, prompt eligibility, `claude -p` topic generation and
 * sanitising. Adapters only decide where the resulting title goes.
 */
const childProcess = require('node:child_process');
const { loadConfig } = require('../../lib/config');
const title = require('../../lib/title');
const { generateTopic } = require('../../lib/generate');

function defaultGit(cwd) {
  return (args) => {
    try {
      const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
}

/** Project name only (no model call). */
function projectTitle({ cwd, env = process.env, git = defaultGit(cwd) }) {
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const cfg = loadConfig({ env, repoRoot });
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  return { cfg, project };
}

/**
 * @param {{prompt:string, cwd:string, env?:object, git?:Function, generate?:Function, log?:Function}} opts
 * @returns {Promise<{title:string|null, project:string|null, topic:string|null, reason:string}>}
 *   reason: 'ok' | 'disabled' | 'ineligible' | 'generation-failed'
 */
async function makeTitle({ prompt, cwd, env = process.env, git = defaultGit(cwd), generate = generateTopic, log = () => {} }) {
  const { cfg, project } = projectTitle({ cwd, env, git });
  if (!cfg.enabled) return { title: null, project, topic: null, reason: 'disabled' };
  if (!title.isEligiblePrompt(prompt)) return { title: project, project, topic: null, reason: 'ineligible' };
  let raw = null;
  try {
    raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log });
  } catch (err) {
    log(`generate threw: ${err && err.message}`);
  }
  const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
  if (!topic) return { title: project, project, topic: null, reason: 'generation-failed' };
  return { title: title.formatTitle(project, topic, { separator: cfg.separator }), project, topic, reason: 'ok' };
}

module.exports = { makeTitle, projectTitle, defaultGit };
