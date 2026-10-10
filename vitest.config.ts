import { configDefaults, defineConfig } from 'vitest/config';

// Agent worktrees live under .claude/worktrees inside the project; without this exclude
// `npm test` would also run every worktree's copy of the suite.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
