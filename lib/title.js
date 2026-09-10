'use strict';
/**
 * Pure helpers: no I/O, no process access. Everything here is deterministic
 * and unit-tested in isolation.
 */
const path = require('node:path');

const TITLE_MAX = 80;
const TOPIC_MAX = 60;
const TOPIC_MIN_WORDS = 2;
const TOPIC_MAX_WORDS = 12;
const PROMPT_MIN_CHARS = 12;

/** Short acknowledgements that never deserve a title. Lower-case, trimmed. */
const ACK_WORDS = Object.freeze([
  'ok', 'okay', 'k', 'yes', 'no', 'sim', 'não', 'nao', 'continue', 'continua', 'go', 'hi', 'hello',
  'olá', 'ola', 'thanks', 'thank you', 'obrigado', 'obrigada', 'done', 'feito', 'next', 'próximo',
  'proximo', 'y', 'n', 'sure', 'claro', 'segue', 'avança', 'avanca', 'prossegue', 'vai',
]);

// Emoji and pictographs, variation selectors, ZWJ. Kept broad on purpose.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
// ANSI escapes, then C0/C1 control characters.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// "Title:", "Título:", "Session title -", "Topic:" style prefixes the model may add.
const PREFIX_RE = /^(?:(?:session\s+)?title|t[ií]tulo|topic|tema|assunto|subject)\s*[:\-–—]\s*/i;

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Trim a string at a word boundary so that it is at most `max` chars. */
function trimAtWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const idx = cut.lastIndexOf(' ');
  const out = (idx > 0 ? cut.slice(0, idx) : s.slice(0, max)).trim();
  return out.replace(/[\s.,;:!?\-–—]+$/u, '');
}

/**
 * Normalise a model answer into a usable topic.
 * @returns {string|null} null when the answer is unusable.
 */
function sanitizeTopic(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(EMOJI_RE, '');
  s = s.replace(/\r?\n/g, ' ');
  s = collapse(s);
  // Strip one layer of wrapping quotes/backticks.
  s = s.replace(/^["'`“”«»]+/u, '').replace(/["'`“”«»]+$/u, '');
  s = collapse(s.replace(PREFIX_RE, ''));
  s = s.replace(/[\s.:;,!?]+$/u, '');
  s = collapse(s);
  if (!s) return null;
  const words = s.split(' ');
  if (words.length < TOPIC_MIN_WORDS || words.length > TOPIC_MAX_WORDS) return null;
  s = trimAtWord(s, TOPIC_MAX);
  return s || null;
}

/**
 * "<project><separator><topic>", capped at TITLE_MAX. The topic is trimmed
 * first (word boundary), the project only if still too long.
 */
function formatTitle(project, topic, { separator = ' - ' } = {}) {
  const proj = collapse(String(project || ''));
  const top = collapse(String(topic || ''));
  if (!top) return trimAtWord(proj, TITLE_MAX) || proj.slice(0, TITLE_MAX);
  const budgetForTopic = TITLE_MAX - proj.length - separator.length;
  if (budgetForTopic >= 8) {
    return `${proj}${separator}${trimAtWord(top, budgetForTopic)}`;
  }
  // Project itself is huge: keep a short topic and cut the project.
  const shortTopic = trimAtWord(top, 20);
  const projBudget = TITLE_MAX - separator.length - shortTopic.length;
  return `${proj.slice(0, projBudget).trimEnd()}${separator}${shortTopic}`;
}

/** Decide whether a user prompt is worth a model call for a title. */
function isEligiblePrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const s = prompt.trim();
  if (s.length < PROMPT_MIN_CHARS) return false;
  if (/^[/!#]/.test(s)) return false;
  // Only file references / paste markers, nothing else.
  const stripped = s.replace(/@\S+/g, '').replace(/\[Pasted text[^\]]*\]/gi, '').trim();
  if (stripped.length < PROMPT_MIN_CHARS) return false;
  const norm = s.toLowerCase().replace(/[\s.,!?;:]+$/u, '').replace(/^[\s.,!?;:]+/u, '');
  if (ACK_WORDS.includes(norm)) return false;
  // "Continua por favor, obrigado!" and similar short acks made of ack-ish words.
  const tokens = norm.split(/[\s,]+/).filter(Boolean);
  const filler = new Set(['por', 'favor', 'please', 'pls', 'pf', 'e', 'and', 'then', 'depois', 'agora', 'now']);
  if (tokens.length <= 4 && tokens.every((t) => ACK_WORDS.includes(t) || filler.has(t))) return false;
  return true;
}

/** Keep the head and tail of very long prompts to bound model cost. */
function truncatePrompt(prompt, head = 1500, tail = 300) {
  const s = String(prompt || '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n…\n${s.slice(-tail)}`;
}

const basenameAny = (p) => {
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (/^[A-Za-z]:$/.test(base)) return base[0]; // drive root such as C:\
  return base;
};

/**
 * Resolve the project name.
 * @param {{cwd:string, projectSource:'git'|'cwd', git?:(args:string[])=>string|null, override?:string|null}} opts
 */
function resolveProject({ cwd, projectSource = 'git', git, override = null }) {
  if (override && String(override).trim()) return String(override).trim();
  const cwdBase = basenameAny(cwd) || (/^[A-Za-z]:/.test(String(cwd)) ? String(cwd)[0] : 'root');
  if (projectSource !== 'git' || typeof git !== 'function') return cwdBase;
  let common = null;
  try {
    common = git(['rev-parse', '--git-common-dir']);
  } catch {
    common = null;
  }
  if (!common || typeof common !== 'string') return cwdBase;
  let dir = common.trim().replace(/\\/g, '/');
  if (!dir) return cwdBase;
  if (!path.posix.isAbsolute(dir) && !/^[A-Za-z]:\//.test(dir)) {
    dir = path.posix.join(String(cwd).replace(/\\/g, '/'), dir);
  }
  // .../repo/.git  or .../repo/.git/worktrees/name  -> repo
  const parts = dir.split('/').filter(Boolean);
  const gitIdx = parts.lastIndexOf('.git');
  if (gitIdx > 0) return parts[gitIdx - 1];
  // Bare repos or unusual layouts: parent of the common dir.
  return parts.length >= 2 ? parts[parts.length - 2] : cwdBase;
}

module.exports = {
  sanitizeTopic, formatTitle, isEligiblePrompt, truncatePrompt, resolveProject,
  ACK_WORDS, TITLE_MAX, TOPIC_MAX,
};
