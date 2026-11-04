// OpenCode plugin entry point (also loads in Kilo CLI, an OpenCode fork).
// The loader rejects modules with non-plugin exports, so this file exports
// only the v1 plugin object. The logic lives in namer.js (CommonJS), which
// reuses the repository's lib/ directly; nothing is vendored.
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { createSessionNamer } = require("./namer.js")

export default {
  id: "session-namer",
  server: async (input) =>
    createSessionNamer({ client: input.client, directory: input.directory, worktree: input.worktree }),
}
