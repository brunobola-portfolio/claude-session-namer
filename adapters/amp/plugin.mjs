// Amp plugin entry (ESM). Amp runs plugins on its bundled Bun runtime, which
// can load the CommonJS adapter core and the repository lib/ through createRequire.
// Install: see adapters/amp/README.md (a one-line shim in the Amp plugins folder
// re-exports this file).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createAmpNamer } = require('./namer.js')
const state = require('../../lib/state.js')

export default function (amp) {
	const logDir = state.stateDir(process.env)
	const log = (msg) => {
		try { state.appendLog(logDir, `amp ${msg}`) } catch {}
		try { amp.logger.log(`[session-namer] ${msg}`) } catch {}
	}
	let cwd = process.cwd()
	try {
		const root = amp.system && amp.system.workspaceRoot
		if (root) cwd = amp.helpers && amp.helpers.filePathFromURI ? amp.helpers.filePathFromURI(root) : fileURLToPath(String(root))
	} catch {}
	const namer = createAmpNamer({ cwd, log })
	if (!namer.enabled) return
	log(`loaded for project "${namer.project}" (${cwd})`)
	amp.on('agent.start', async (event, ctx) => {
		try { await namer.onAgentStart(event, ctx) } catch (err) { log(`agent.start error: ${err && err.message}`) }
		return {}
	})
	amp.on('agent.end', async (event, ctx) => {
		try { await namer.onAgentEnd(event, ctx) } catch (err) { log(`agent.end error: ${err && err.message}`) }
	})
}
