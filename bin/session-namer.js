#!/usr/bin/env node
'use strict';
// session-namer installer: npx -y github:brunobola-portfolio/claude-session-namer <command>
const { main } = require('../lib/install');

// `session-namer list | head`: the reader went away; stop quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(process.exitCode || 0);
    throw err;
  });
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`session-namer: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
