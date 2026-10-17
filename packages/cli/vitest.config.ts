import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 60000, fileParallelism: false },
})
