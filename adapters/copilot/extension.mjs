// session-namer for GitHub Copilot CLI (extensions are an experimental
// Copilot feature). Names every session "<project> - <topic>" through the
// SDK's session.rpc.name.set. Registers no hooks and no tools, so Copilot
// asks for no extra permission.
//
// Copilot resolves `@github/copilot-sdk` only for files inside its extension
// folders, so the installed entry file (written by install.js) imports the
// SDK itself and hands `joinSession` to start() below.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCopilotNamer } = require('./namer.js');

/** @param {Function} joinSession from '@github/copilot-sdk/extension' */
export async function start(joinSession) {
  let namer = null;
  let session = null;
  const commands = [{
    name: 'session-name',
    description: 'Rename this session (project - topic), or --regenerate the topic',
    handler: async (ctx) => {
      const msg = namer ? await namer.command(ctx && ctx.args) : 'session-namer is disabled.';
      try { await session.log(msg); } catch { /* ignore */ }
    },
  }];
  session = await joinSession({ commands });
  if (process.env.SESSION_NAMER_NESTED === '1') return session;
  namer = createCopilotNamer({ session });
  session.on('session.context_changed', (ev) => namer.onContextChanged(ev));
  session.on('session.title_changed', () => { namer.onTitleChanged(); });
  session.on('user.message', (ev) => { namer.onUserMessage(ev); });
  await namer.start();
  return session;
}
