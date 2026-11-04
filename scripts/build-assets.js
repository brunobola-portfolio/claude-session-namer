#!/usr/bin/env node
'use strict';
/**
 * Generates the README artwork in docs/assets/ as light and dark SVG pairs.
 * GitHub renders SVGs through <img>, so everything is static: no scripts,
 * no web fonts (system stacks only), no external references.
 *
 *   node scripts/build-assets.js
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'docs', 'assets');

const THEMES = {
  light: {
    bg: '#FBFBF8', panel: '#FFFFFF', line: '#E3E5EA', ink: '#18202E', muted: '#5F6779', dim: '#687082', faint: '#A7ADBA',
    tape: '#2346D8', tapeEdge: '#1A36AC', tapeShine: '#4A68E6', tapeText: '#FFFFFF', tapeShadow: '#10247A',
    chip: '#F2C230', chipInk: '#3A2E00', accent: '#2346D8', strike: '#C3C7D0',
  },
  dark: {
    bg: '#151A23', panel: '#1B212C', line: '#2A3240', ink: '#E7EAF0', muted: '#98A1B3', dim: '#8A93A6', faint: '#5E6779',
    tape: '#3E5FF0', tapeEdge: '#2E4BCF', tapeShine: '#6680FF', tapeText: '#FFFFFF', tapeShadow: '#1A2C8C',
    chip: '#F2C230', chipInk: '#3A2E00', accent: '#7D93FF', strike: '#434C5C',
  },
};

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
/** Average advance of the monospace stacks above, as a fraction of font size. */
const MONO_ADVANCE = 0.6;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const monoWidth = (text, size) => [...text].length * size * MONO_ADVANCE;

/**
 * Embossed label-maker tape. Text is drawn twice (dark offset + white) for the
 * pressed-plastic look; textLength pins the width so fonts cannot overflow it.
 */
function tape(t, { x, y, text, size = 22, rotate = 0, padX = 18 }) {
  const textW = monoWidth(text, size);
  const w = Math.round(textW + padX * 2);
  const h = Math.round(size * 1.9);
  const cut = 7;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const baseline = y + h / 2 + size * 0.35;
  const body = `M${x},${y + 3} Q${x},${y} ${x + 3},${y} L${x + w - cut},${y} L${x + w},${y + h / 2} L${x + w - cut},${y + h} L${x + 3},${y + h} Q${x},${y + h} ${x},${y + h - 3} Z`;
  return `
  <g transform="rotate(${rotate} ${cx} ${cy})">
    <path d="${body}" fill="${t.tapeEdge}" transform="translate(0 2)"/>
    <path d="${body}" fill="${t.tape}"/>
    <rect x="${x + 4}" y="${y + 3}" width="${w - cut - 8}" height="2" rx="1" fill="${t.tapeShine}" opacity="0.55"/>
    <text x="${x + padX}" y="${baseline + 1.2}" font-family="${MONO}" font-size="${size}" font-weight="700" fill="${t.tapeShadow}" textLength="${textW}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>
    <text x="${x + padX}" y="${baseline}" font-family="${MONO}" font-size="${size}" font-weight="700" fill="${t.tapeText}" textLength="${textW}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>
  </g>`;
}

const svg = (w, h, t, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${t.line}"/>${body}
</svg>
`;

// ---------------------------------------------------------------- hero
function hero(t) {
  const W = 1280; const H = 440;
  const body = `
  <text x="64" y="118" font-family="${SANS}" font-size="64" font-weight="800" letter-spacing="-1.5" fill="${t.ink}">session-namer</text>
  <text x="66" y="166" font-family="${SANS}" font-size="24" fill="${t.muted}">Project-first titles for every AI coding session, written from your first</text>
  <text x="66" y="200" font-family="${SANS}" font-size="24" fill="${t.muted}">prompt in your language, and kept stable everywhere you open it.</text>
  ${tape(t, { x: 64, y: 250, text: 'webapp - Fix Safari login redirect loop', size: 24, rotate: -1.2 })}
  ${tape(t, { x: 520, y: 304, text: 'arcva-2.0 - Migração de faturas para V10', size: 24, rotate: 0.9 })}
  ${tape(t, { x: 210, y: 362, text: 'crm - Paginación en listado de clientes', size: 24, rotate: -0.5 })}`;
  return svg(W, H, t, body, 'session-namer: automatic, readable titles for AI coding sessions');
}

// ---------------------------------------------------------------- before / after
const ROWS = [
  ['Fix failing tests', 'api', 'Fix failing invoice export tests', '3m'],
  ['Fix failing tests', 'webapp', 'Fix flaky checkout e2e tests', '18m'],
  ['Migra as faturas para a V10 e valida…', 'arcva-2.0', 'Migração de faturas para V10', '1h'],
  ['bruno-w11-graceful-unicorn', 'crm', 'Paginación en listado de clientes', '2h'],
  ['Implement the changes we discussed', 'infra', 'Rotate staging TLS certificates', 'yesterday'],
];

function beforeAfter(t) {
  const W = 1280; const rowH = 52; const top = 112; const H = top + ROWS.length * rowH + 44;
  const L = 40; const LW = 500; const R = 600; const RW = 640;
  let rows = '';
  ROWS.forEach(([before, project, topic, age], i) => {
    const y = top + i * rowH;
    const mid = y + rowH / 2 + 6;
    const chipW = Math.round(monoWidth(project, 16) + 20);
    rows += `
  <line x1="${L + 16}" y1="${y + rowH}" x2="${L + LW - 16}" y2="${y + rowH}" stroke="${t.line}"/>
  <line x1="${R + 16}" y1="${y + rowH}" x2="${R + RW - 16}" y2="${y + rowH}" stroke="${t.line}"/>
  <text x="${L + 24}" y="${mid}" font-family="${MONO}" font-size="16" fill="${t.muted}">${esc(before)}</text>
  <text x="${L + LW - 24}" y="${mid}" text-anchor="end" font-family="${SANS}" font-size="13" fill="${t.dim}">${esc(age)}</text>
  <path d="M${L + LW + 22},${y + rowH / 2} h40 m-8,-6 l8,6 l-8,6" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${R + 24}" y="${y + 13}" width="${chipW}" height="26" rx="5" fill="${t.chip}"/>
  <text x="${R + 34}" y="${mid - 1}" font-family="${MONO}" font-size="16" font-weight="700" fill="${t.chipInk}" textLength="${monoWidth(project, 16)}" lengthAdjust="spacingAndGlyphs">${esc(project)}</text>
  <text x="${R + 24 + chipW + 12}" y="${mid - 1}" font-family="${MONO}" font-size="16" fill="${t.ink}"><tspan fill="${t.muted}">- </tspan>${esc(topic)}</text>
  <text x="${R + RW - 24}" y="${mid}" text-anchor="end" font-family="${SANS}" font-size="13" fill="${t.muted}">${esc(age)}</text>`;
  });
  const body = `
  <rect x="${L}" y="64" width="${LW}" height="${H - 92}" rx="10" fill="${t.panel}" stroke="${t.line}"/>
  <rect x="${R}" y="64" width="${RW}" height="${H - 92}" rx="10" fill="${t.panel}" stroke="${t.accent}" stroke-width="1.5"/>
  <text x="${L + 4}" y="44" font-family="${SANS}" font-size="18" font-weight="700" fill="${t.muted}">Native titles</text>
  <text x="${R + 4}" y="44" font-family="${SANS}" font-size="18" font-weight="700" fill="${t.ink}">With session-namer</text>
  <text x="${L + 24}" y="96" font-family="${MONO}" font-size="13" fill="${t.dim}">claude --resume</text>
  <text x="${R + 24}" y="96" font-family="${MONO}" font-size="13" fill="${t.muted}">claude --resume</text>${rows}`;
  return svg(W, H, t, body, 'Session list before and after session-namer');
}

// ---------------------------------------------------------------- flow
function flow(t) {
  const W = 1280; const H = 512;
  const steps = [
    { n: '1', head: 'Session starts', lines: ['Title becomes the git repo name.', 'Worktree-aware. No network, 0 ms.'], tag: 'arcva-2.0' },
    { n: '2', head: 'First real prompt', lines: ['A fast model writes a 3 to 7 word', 'topic in your language, through', 'your own Claude login.'], tag: 'arcva-2.0 - Migração de faturas' },
    { n: '3', head: 'Next two prompts', lines: ['The title is re-asserted so the', 'VS Code sidebar cannot drift.', 'No model call.'], tag: 'arcva-2.0 - Migração de faturas' },
  ];
  const x0 = 52; const gap = 34; const colW = Math.floor((1280 - 2 * x0 - 2 * gap) / 3);
  let cols = '';
  steps.forEach((s, i) => {
    const x = x0 + i * (colW + gap);
    cols += `
  <rect x="${x}" y="72" width="${colW}" height="236" rx="12" fill="${t.panel}" stroke="${t.line}"/>
  <circle cx="${x + 36}" cy="112" r="17" fill="none" stroke="${t.accent}" stroke-width="2"/>
  <text x="${x + 36}" y="118" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.accent}">${s.n}</text>
  <text x="${x + 66}" y="119" font-family="${SANS}" font-size="21" font-weight="700" fill="${t.ink}">${esc(s.head)}</text>
  ${s.lines.map((l, j) => `<text x="${x + 24}" y="${166 + j * 26}" font-family="${SANS}" font-size="16" fill="${t.muted}">${esc(l)}</text>`).join('\n  ')}
  ${tape(t, { x: x + 22, y: 250, text: s.tag, size: 15, padX: 12 })}`;
    if (i < steps.length - 1) {
      const ax = x + colW + 4;
      cols += `
  <path d="M${ax},207 h${gap - 8} m-7,-6 l7,6 l-7,6" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  const guards = [
    ['Trivial prompts', 'ok, continua, /resume, bare @file: no model call, title stays as is.'],
    ['Your title wins', 'Renamed with /rename, --name or claude.ai? The plugin never touches it again.'],
    ['Fails safe', 'Timeout or error keeps the project title; at most 3 attempts, one per minute.'],
  ];
  const gy = 344;
  const guardsSvg = guards.map(([h, d], i) => {
    const y = gy + i * 46;
    return `
  <rect x="52" y="${y}" width="6" height="30" rx="3" fill="${t.chip}"/>
  <text x="74" y="${y + 21}" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.ink}">${esc(h)}</text>
  <text x="254" y="${y + 21}" font-family="${SANS}" font-size="16" fill="${t.muted}">${esc(d)}</text>`;
  }).join('');
  const body = `
  <text x="52" y="46" font-family="${SANS}" font-size="15" fill="${t.dim}">What happens in one Claude Code session</text>${cols}${guardsSvg}`;
  return svg(W, H, t, body, 'How session-namer titles a session in three steps');
}

// ---------------------------------------------------------------- harness strip + social card
/** Support levels, as verified live. Keep in sync with docs/harnesses.md. */
const SESSION_TITLE = ['Claude Code', 'Codex CLI', 'Pi', 'OpenCode', 'Kilo CLI', 'Copilot CLI', 'Cline CLI', 'Crush', 'goose', 'DeepSeek Harness'];
const PARTLY = ['Amp', 'Grok Build'];
const TAB_TITLE = ['Gemini CLI', 'Qwen Code'];
const HARNESSES = [...SESSION_TITLE, ...PARTLY, ...TAB_TITLE];

function chips(t, names, { x0, y0, maxW, size = 17, gap = 12, rowGap = 14, dashed = false }) {
  let x = x0; let y = y0; let out = '';
  const h = Math.round(size * 2);
  for (const name of names) {
    const w = Math.round(name.length * size * 0.56 + 30);
    if (x + w > x0 + maxW) { x = x0; y += h + rowGap; }
    out += `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${t.panel}" stroke="${dashed ? t.muted : t.line}"${dashed ? ' stroke-dasharray="4 3"' : ''}/>
  <text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="600" fill="${t.ink}">${esc(name)}</text>`;
    x += w + gap;
  }
  return { svg: out, bottom: y + h };
}

function harnessStrip(t) {
  const W = 1280;
  const a = chips(t, SESSION_TITLE, { x0: 52, y0: 70, maxW: 1176 });
  const by = a.bottom + 58;
  const b = chips(t, PARTLY, { x0: 52, y0: by, maxW: 520, dashed: true });
  const c = chips(t, TAB_TITLE, { x0: 680, y0: by, maxW: 560, dashed: true });
  const H = Math.max(b.bottom, c.bottom) + 36;
  const body = `
  <text x="52" y="46" font-family="${SANS}" font-size="15" fill="${t.muted}">Session title, set automatically and verified live</text>${a.svg}
  <text x="52" y="${by - 16}" font-family="${SANS}" font-size="15" fill="${t.muted}">Session title, partly verified</text>${b.svg}
  <text x="680" y="${by - 16}" font-family="${SANS}" font-size="15" fill="${t.muted}">Terminal tab title only</text>${c.svg}`;
  return svg(W, H, t, body, `Session title: ${SESSION_TITLE.join(', ')}. Partly verified: ${PARTLY.join(', ')}. Tab title only: ${TAB_TITLE.join(', ')}.`);
}

function social(t) {
  const W = 1280; const H = 640;
  const c = chips(t, HARNESSES, { x0: 64, y0: 452, maxW: 1152, size: 16, gap: 10, rowGap: 10 });
  const body = `
  <text x="64" y="140" font-family="${SANS}" font-size="84" font-weight="800" letter-spacing="-2" fill="${t.ink}">session-namer</text>
  <text x="68" y="200" font-family="${SANS}" font-size="30" fill="${t.muted}">Project-first titles for every AI coding session.</text>
  ${tape(t, { x: 64, y: 262, text: 'webapp - Fix Safari login redirect loop', size: 30, rotate: -1.2 })}
  ${tape(t, { x: 330, y: 348, text: 'arcva-2.0 - Migração de faturas para V10', size: 30, rotate: 0.8 })}${c.svg}
  <text x="${W - 64}" y="${H - 36}" text-anchor="end" font-family="${SANS}" font-size="18" fill="${t.dim}">Open source, MIT. BolaLabs</text>`;
  return svg(W, H, t, body, 'session-namer social card');
}

// ---------------------------------------------------------------- narrow (phone) variants
// Served through <picture media="(max-width: 600px)">: 720 px wide, so text
// stays at 12 px or more once the image is scaled to a phone's width.
const NW = 720;
/** Cut text with an ellipsis only when it would not fit in `width` px. */
const fitMono = (s, width, size) => { const max = Math.floor(width / (size * MONO_ADVANCE)); return [...s].length <= max ? s : `${[...s].slice(0, max - 1).join('')}…`; };

function heroNarrow(t) {
  const H = 560;
  const body = `
  <text x="40" y="96" font-family="${SANS}" font-size="64" font-weight="800" letter-spacing="-1.5" fill="${t.ink}">session-namer</text>
  <text x="42" y="150" font-family="${SANS}" font-size="28" fill="${t.muted}">Project-first titles for every</text>
  <text x="42" y="188" font-family="${SANS}" font-size="28" fill="${t.muted}">AI coding session.</text>
  ${tape(t, { x: 40, y: 250, text: 'webapp - Fix login redirect', size: 30, rotate: -1.2, padX: 20 })}
  ${tape(t, { x: 64, y: 340, text: 'arcva-2.0 - Faturas para V10', size: 30, rotate: 0.9, padX: 20 })}
  ${tape(t, { x: 48, y: 430, text: 'crm - Paginación de clientes', size: 30, rotate: -0.5, padX: 20 })}`;
  return svg(NW, H, t, body, 'session-namer: project-first titles for every AI coding session');
}

function beforeAfterNarrow(t) {
  const rowH = 104; const top = 92; const H = top + ROWS.length * rowH + 28;
  let rows = '';
  ROWS.forEach(([before, project, topic], i) => {
    const y = top + i * rowH;
    const chipW = Math.round(monoWidth(project, 24) + 24);
    rows += `
  <text x="40" y="${y + 30}" font-family="${MONO}" font-size="22" fill="${t.dim}">${esc(before.length > 34 ? `${before.slice(0, 33)}…` : before)}</text>
  <rect x="40" y="${y + 46}" width="${chipW}" height="38" rx="6" fill="${t.chip}"/>
  <text x="52" y="${y + 73}" font-family="${MONO}" font-size="24" font-weight="700" fill="${t.chipInk}" textLength="${monoWidth(project, 24)}" lengthAdjust="spacingAndGlyphs">${esc(project)}</text>
  <text x="${40 + chipW + 12}" y="${y + 72}" font-family="${MONO}" font-size="20" fill="${t.ink}"><tspan fill="${t.muted}">- </tspan>${esc(fitMono(topic, NW - 40 - (40 + chipW + 12) - monoWidth('- ', 20), 20))}</text>
  <line x1="40" y1="${y + rowH - 4}" x2="${NW - 40}" y2="${y + rowH - 4}" stroke="${t.line}"/>`;
  });
  const body = `
  <text x="40" y="52" font-family="${SANS}" font-size="26" font-weight="700" fill="${t.ink}">Native title, then session-namer</text>${rows}`;
  return svg(NW, H, t, body, 'Session titles before and after session-namer');
}

function flowNarrow(t) {
  const steps = [
    ['1', 'Session starts', 'Title becomes the git repo name.'],
    ['2', 'First real prompt', 'A fast model writes a short topic.'],
    ['3', 'Next two prompts', 'The title is set again, then left alone.'],
  ];
  const stepH = 132; const H = 60 + steps.length * stepH + 20;
  const body = `
  <text x="40" y="44" font-family="${SANS}" font-size="22" fill="${t.dim}">What happens in one Claude Code session</text>
  ${steps.map(([n, head, line], i) => {
    const y = 70 + i * stepH;
    return `<rect x="40" y="${y}" width="${NW - 80}" height="${stepH - 20}" rx="12" fill="${t.panel}" stroke="${t.line}"/>
  <circle cx="84" cy="${y + 56}" r="22" fill="none" stroke="${t.accent}" stroke-width="2.5"/>
  <text x="84" y="${y + 64}" text-anchor="middle" font-family="${SANS}" font-size="22" font-weight="700" fill="${t.accent}">${n}</text>
  <text x="126" y="${y + 46}" font-family="${SANS}" font-size="28" font-weight="700" fill="${t.ink}">${esc(head)}</text>
  <text x="126" y="${y + 84}" font-family="${SANS}" font-size="22" fill="${t.muted}">${esc(line)}</text>`;
  }).join('\n  ')}`;
  return svg(NW, H, t, body, 'How session-namer titles a session in three steps');
}

function harnessNarrow(t) {
  const a = chips(t, SESSION_TITLE, { x0: 40, y0: 72, maxW: NW - 80, size: 22, gap: 12, rowGap: 14 });
  const by = a.bottom + 70;
  const b = chips(t, [...PARTLY, ...TAB_TITLE], { x0: 40, y0: by, maxW: NW - 80, size: 22, gap: 12, rowGap: 14, dashed: true });
  const H = b.bottom + 36;
  const body = `
  <text x="40" y="46" font-family="${SANS}" font-size="22" fill="${t.muted}">Session title, verified live</text>${a.svg}
  <text x="40" y="${by - 20}" font-family="${SANS}" font-size="22" fill="${t.muted}">Partly verified, or terminal tab only</text>${b.svg}`;
  return svg(NW, H, t, body, `Session title: ${SESSION_TITLE.join(', ')}. Partly verified: ${PARTLY.join(', ')}. Tab title only: ${TAB_TITLE.join(', ')}.`);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = {
    hero, 'before-after': beforeAfter, flow, harnesses: harnessStrip, social,
    'hero-narrow': heroNarrow, 'before-after-narrow': beforeAfterNarrow, 'flow-narrow': flowNarrow, 'harnesses-narrow': harnessNarrow,
  };
  for (const [name, fn] of Object.entries(jobs)) {
    for (const [themeName, t] of Object.entries(THEMES)) {
      const file = path.join(OUT, `${name}-${themeName}.svg`);
      fs.writeFileSync(file, fn(t));
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
  }
}

if (require.main === module) main();
module.exports = { THEMES, tape, monoWidth };
