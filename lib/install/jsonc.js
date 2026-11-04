'use strict';
/**
 * Minimal comment-preserving JSONC handling for the installer.
 *
 * parse() builds a tree with source offsets; the edit helpers return a new
 * text that differs from the input only by the inserted, replaced or removed
 * span. Comments, formatting and key order of everything else stay
 * byte-for-byte as they were, and every insertion made here is undone
 * exactly by the matching removal (the property that lets uninstall restore
 * a config file to its original bytes).
 */

class JsoncError extends Error {}

function parse(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  function fail(msg) {
    const line = text.slice(0, i).split('\n').length;
    throw new JsoncError(`${msg} at line ${line}`);
  }

  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        while (i < n && text[i] !== '\n') i++;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment');
        i = end + 2;
      } else {
        return;
      }
    }
  }

  function str() {
    const start = i;
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') fail('newline in string');
      i++;
    }
    if (i >= n) fail('unterminated string');
    i++;
    return { type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) };
  }

  function value() {
    skip();
    if (i >= n) fail('unexpected end');
    const c = text[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail(`unexpected character ${JSON.stringify(c)}`);
    const start = i;
    i += m[0].length;
    const v = JSON.parse(m[0]);
    return { type: v === null ? 'null' : typeof v, start, end: i, value: v };
  }

  function obj() {
    const node = { type: 'object', start: i, end: 0, members: [] };
    i++;
    for (;;) {
      skip();
      if (text[i] === '}') { i++; break; }
      if (text[i] !== '"') fail('expected property name');
      const key = str();
      skip();
      if (text[i] !== ':') fail('expected ":"');
      i++;
      const v = value();
      node.members.push({ key: key.value, start: key.start, end: v.end, value: v });
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail('expected "," or "}"');
    }
    node.end = i;
    return node;
  }

  function arr() {
    const node = { type: 'array', start: i, end: 0, items: [] };
    i++;
    for (;;) {
      skip();
      if (text[i] === ']') { i++; break; }
      node.items.push(value());
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      fail('expected "," or "]"');
    }
    node.end = i;
    return node;
  }

  const root = value();
  skip();
  if (i < n) fail('unexpected content after the root value');
  return root;
}

/** Plain JS value of a node. */
function toValue(node) {
  if (node.type === 'object') {
    const o = {};
    for (const m of node.members) o[m.key] = toValue(m.value);
    return o;
  }
  if (node.type === 'array') return node.items.map(toValue);
  return node.value;
}

function parseValue(text) {
  return toValue(parse(text));
}

/** Member (or null) of an object node. Last one wins, as in JSON.parse. */
function member(node, key) {
  if (!node || node.type !== 'object') return null;
  let found = null;
  for (const m of node.members) if (m.key === key) found = m;
  return found;
}

/** Node at a key path, or null. */
function at(root, keys) {
  let node = root;
  for (const k of keys) {
    const m = member(node, k);
    if (!m) return null;
    node = m.value;
  }
  return node;
}

function detectIndentUnit(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

/** Line ending of the file: CRLF when it has any, else LF. */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineIndent(text, offset) {
  const ls = text.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls, offset));
  return m[0];
}

/** Children spans of a container: [{start, end}] for members or items. */
function children(node) {
  return node.type === 'object' ? node.members : node.items;
}

/**
 * Text to insert for a new last child. `render(indent)` gives the child
 * text for a given indentation (used to pretty-print multi-line values).
 */
function insertChild(text, node, render) {
  const kids = children(node);
  if (kids.length === 0) {
    const pos = node.start + 1;
    return text.slice(0, pos) + render(null) + text.slice(pos);
  }
  const last = kids[kids.length - 1];
  const before = text.slice(kids.length > 1 ? kids[kids.length - 2].end : node.start + 1, last.start);
  const ownLine = before.includes('\n');
  const indent = ownLine ? lineIndent(text, last.start) : null;
  const sep = ownLine ? `,${detectEol(text)}${indent}` : ', ';
  return text.slice(0, last.end) + sep + render(indent) + text.slice(last.end);
}

/** Remove child #index; the exact inverse of insertChild for the last child. */
function removeChild(text, node, index) {
  const kids = children(node);
  const kid = kids[index];
  if (index > 0) return text.slice(0, kids[index - 1].end) + text.slice(kid.end);
  if (kids.length > 1) return text.slice(0, kid.start) + text.slice(kids[1].start);
  // Only child: drop it and a trailing comma, keep surrounding whitespace/comments.
  let end = kid.end;
  const rest = /^\s*,/.exec(text.slice(end));
  if (rest) end += rest[0].length;
  return text.slice(0, kid.start) + text.slice(end);
}

function replaceSpan(text, node, newText) {
  return text.slice(0, node.start) + newText + text.slice(node.end);
}

function formatValue(value, indent, unit, eol = '\n') {
  if (indent === null) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).replace(/\n/g, `${eol}${indent}`);
}

function buildNested(keys, leaf) {
  let v = leaf;
  for (let k = keys.length - 1; k >= 0; k--) v = { [keys[k]]: v };
  return v;
}

/**
 * Apply one operation and return { text, created } where `created` lists the
 * key paths that did not exist before (so uninstall can prune them).
 *   op = { path: [...keys], item }   append item to the array at path (created if missing)
 *   op = { path: [...keys], value }  set a scalar only if absent
 */
function ensureContainerPath(text, path, leafValue) {
  const root = parse(text);
  const unit = detectIndentUnit(text);
  if (root.type !== 'object') throw new JsoncError('the root is not an object');
  let node = root;
  for (let d = 0; d < path.length; d++) {
    const m = member(node, path[d]);
    if (!m) {
      const rest = path.slice(d + 1);
      const key = path[d];
      const value = buildNested(rest, leafValue);
      const out = insertChild(text, node, (indent) => `${JSON.stringify(key)}: ${formatValue(value, indent, unit, detectEol(text))}`);
      const created = [];
      for (let k = d; k < path.length; k++) created.push(path.slice(0, k + 1));
      return { text: out, created, inserted: true };
    }
    node = m.value;
    if (d < path.length - 1 && node.type !== 'object') {
      throw new JsoncError(`"${path.slice(0, d + 1).join('.')}" is not an object`);
    }
  }
  return { text, created: [], inserted: false, node };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Ensure exactly one array element at `path` satisfies isOurs and equals
 * `item`. Returns { text, created, action } with action one of
 * 'added' | 'updated' | 'unchanged'.
 */
function ensureArrayItem(text, path, item, isOurs) {
  const r = ensureContainerPath(text, path, [item]);
  if (r.inserted) return { text: r.text, created: r.created, action: 'added' };
  if (r.node.type !== 'array') throw new JsoncError(`"${path.join('.')}" is not an array`);
  let out = text;
  let node = r.node;
  const ours = node.items.map((it, idx) => ({ it, idx })).filter(({ it }) => isOurs(out.slice(it.start, it.end)));
  if (ours.length === 0) {
    const unit = detectIndentUnit(out);
    out = insertChild(out, node, (indent) => formatValue(item, indent, unit, detectEol(out)));
    return { text: out, created: [], action: 'added' };
  }
  let action = 'unchanged';
  // Remove duplicates beyond the first (from the end so offsets stay valid).
  for (let k = ours.length - 1; k >= 1; k--) {
    out = removeChild(out, node, ours[k].idx);
    node = at(parse(out), path);
    action = 'updated';
  }
  const first = node.items[ours[0].idx];
  if (!deepEqual(toValue(first), item)) {
    const unit = detectIndentUnit(out);
    const indent = lineIndent(out, first.start);
    const multi = out.slice(first.start, first.end).includes('\n');
    out = replaceSpan(out, first, formatValue(item, multi ? indent : null, unit, detectEol(out)));
    action = 'updated';
  }
  return { text: out, created: [], action };
}

/** Set a scalar if it is absent. Returns { text, created, action, current }. */
function ensureScalar(text, path, value) {
  const r = ensureContainerPath(text, path, value);
  if (r.inserted) return { text: r.text, created: r.created, action: 'added' };
  const current = toValue(r.node);
  return { text, created: [], action: deepEqual(current, value) ? 'unchanged' : 'kept', current };
}

/** Remove every element at `path` that isOurs. Returns { text, removed }. */
function removeArrayItems(text, path, isOurs) {
  let out = text;
  let removed = 0;
  for (;;) {
    const node = at(parse(out), path);
    if (!node || node.type !== 'array') return { text: out, removed };
    let idx = -1;
    for (let k = node.items.length - 1; k >= 0; k--) {
      if (isOurs(out.slice(node.items[k].start, node.items[k].end))) { idx = k; break; }
    }
    if (idx < 0) return { text: out, removed };
    out = removeChild(out, node, idx);
    removed++;
  }
}

/** Remove the member at `path` (object property). */
function removeMember(text, path) {
  const root = parse(text);
  const parent = path.length === 1 ? root : at(root, path.slice(0, -1));
  if (!parent || parent.type !== 'object') return text;
  const key = path[path.length - 1];
  let idx = -1;
  parent.members.forEach((m, k) => { if (m.key === key) idx = k; });
  if (idx < 0) return text;
  return removeChild(text, parent, idx);
}

/**
 * Prune paths the installer created, in reverse creation order (children
 * before parents, later siblings first, so each removal is the exact inverse
 * of its insertion). A container is removed only when empty, a scalar only
 * when it still holds `scalars[path]`.
 */
function pruneCreated(text, createdPaths, scalars = {}) {
  let out = text;
  const paths = [...createdPaths].reverse();
  for (const p of paths) {
    const node = at(parse(out), p);
    if (!node) continue;
    const key = JSON.stringify(p);
    if (node.type === 'object' || node.type === 'array') {
      if (children(node).length === 0) out = removeMember(out, p);
    } else if (key in scalars && deepEqual(toValue(node), scalars[key])) {
      out = removeMember(out, p);
    }
  }
  return out;
}

module.exports = {
  JsoncError,
  parse,
  parseValue,
  toValue,
  at,
  member,
  ensureArrayItem,
  ensureScalar,
  removeArrayItems,
  removeMember,
  pruneCreated,
  insertChild,
  removeChild,
  detectEol,
};
