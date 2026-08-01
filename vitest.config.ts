import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // Keep vitest's defaults (node_modules, dist, …) and also skip Claude Code
    // worktree scratch under .claude/, whose copies of src/**/*.test.ts would
    // otherwise be discovered and double-count the suite.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
