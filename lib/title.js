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
// ANSI CSI and OSC escapes, then C0/C1 controls, bidi overrides/isolates,
// zero-width characters, the BOM and the Unicode tag block.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​‎‏‪-‮⁠-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;
// "Title:", "Título:", "Session title -", "Topic:" style prefixes the model may add.
// A dash only counts with a space before it, so "Topic-based routing" survives.
const PREFIX_RE = /^(?:(?:session\s+)?title|t[ií]tulo|topic|tema|assunto|subject)(?:\s*:|\s+[-–—])\s*/i;
const QUOTES_START = /^["'`“”«»]+/u;
const QUOTES_END = /["'`“”«»]+$/u;
// Scripts written without spaces between words: count characters, not words.
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const UNSPACED_MIN = 2;
const UNSPACED_MAX = 40;
const PROJECT_MAX = 60;

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const stripUnsafe = (s) => String(s).replace(ANSI_RE, '').replace(CONTROL_RE, '');
const unquote = (s) => s.replace(QUOTES_START, '').replace(QUOTES_END, '');

/** Code-point-safe slice (never splits a surrogate pair). */
const sliceCp = (s, n) => [...s].slice(0, n).join('');

/** Trim a string at a word boundary so that it is at most `max` chars. */
function trimAtWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const idx = cut.lastIndexOf(' ');
  const out = (idx > 0 ? cut.slice(0, idx) : sliceCp(s, max)).trim();
  return out.replace(/[\s.,;:!?\-–—]+$/u, '');
}

/**
 * Normalise a model answer into a usable topic.
 * @param {string} raw
 * @param {{maxWords?:number}} [opts] cap the topic at this many words (3 to 12)
 * @returns {string|null} null when the answer is unusable.
 */
function sanitizeTopic(raw, { maxWords = TOPIC_MAX_WORDS } = {}) {
  if (typeof raw !== 'string') return null;
  let s = stripUnsafe(raw).replace(EMOJI_RE, '');
  s = collapse(s.replace(/\r?\n/g, ' '));
  // Quotes may wrap the whole answer or sit after a "Title:" prefix.
  s = collapse(unquote(s));
  s = collapse(unquote(collapse(s.replace(PREFIX_RE, ''))));
  s = collapse(s.replace(/[\s.:;,!?]+$/u, ''));
  if (!s) return null;
  const words = s.split(' ');
  if (words.length === 1 && UNSPACED_RE.test(s)) {
    const n = [...s].length;
    return n >= UNSPACED_MIN && n <= UNSPACED_MAX ? s : null;
  }
  // More than 12 words is an answer, not a title: reject. Otherwise cap.
  if (words.length < TOPIC_MIN_WORDS || words.length > TOPIC_MAX_WORDS) return null;
  const cap = Math.min(TOPIC_MAX_WORDS, Math.max(3, Number(maxWords) || TOPIC_MAX_WORDS));
  const full = s;
  s = words.slice(0, cap).join(' ').replace(/[\s.,;:!?\-–—]+$/u, '');
  s = trimAtWord(s, TOPIC_MAX);
  if (s !== full) s = dropDangling(s);
  return s || null;
}

/** Articles, prepositions and conjunctions that read as cut off at the end of a title. */
const DANGLING = new Set((
  'a an the of to in on at by for from with into and or '
  + 'o os as um uma de da do das dos em no na nos nas para por com e ou ao aos '
  + 'el la los las un una del al en y con '
  + 'le les des du au aux et pour avec sur '
  + 'der die das den dem ein eine und mit für von zu im '
  + 'il lo gli di per nel della'
).split(' '));

/** After a cut, drop trailing connector words ("…expresión regular en" -> "…expresión regular"). */
function dropDangling(s) {
  const words = s.split(' ');
  while (words.length > TOPIC_MIN_WORDS && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').replace(/[\s.,;:!?\-–—]+$/u, '');
}

/** Make a project name safe to show: no control or escape characters, bounded length. */
function sanitizeProject(raw) {
  const s = collapse(stripUnsafe(raw).replace(/\r?\n/g, ' '));
  return trimAtWord(s, PROJECT_MAX) || sliceCp(s, PROJECT_MAX);
}

/**
 * "<project><separator><topic>", capped at TITLE_MAX. The topic is trimmed
 * first (word boundary), the project only if still too long.
 */
function formatTitle(project, topic, { separator = ' - ' } = {}) {
  const proj = collapse(stripUnsafe(project || ''));
  const top = collapse(stripUnsafe(topic || ''));
  separator = stripUnsafe(separator).replace(/[\r\n]/g, '') || ' - ';
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
function resolveProject(opts) {
  return sanitizeProject(resolveProjectRaw(opts)) || 'project';
}

function resolveProjectRaw({ cwd, projectSource = 'git', git, override = null }) {
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
  const parts = dir.split('/').filter(Boolean);
  const gitIdx = parts.indexOf('.git');
  // Submodule: .../parent/.git/modules/<name>[/<nested>] -> the submodule's own name
  if (gitIdx >= 0 && parts[gitIdx + 1] === 'modules' && parts.length > gitIdx + 2) return parts[parts.length - 1];
  // .../repo/.git  or .../repo/.git/worktrees/name  -> repo
  if (gitIdx > 0) return parts[gitIdx - 1];
  // Bare repository: /srv/repo.git -> repo
  const last = parts[parts.length - 1] || '';
  if (/\.git$/i.test(last) && last.length > 4) return last.slice(0, -4);
  // Unusual layouts: parent of the common dir.
  return parts.length >= 2 ? parts[parts.length - 2] : cwdBase;
}

module.exports = {
  sanitizeTopic, sanitizeProject, formatTitle, isEligiblePrompt, truncatePrompt, resolveProject, trimAtWord,
  ACK_WORDS, TITLE_MAX, TOPIC_MAX,
};
