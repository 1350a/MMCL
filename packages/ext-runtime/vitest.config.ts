import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // WASM 重测试用 forks 隔离（共享 worker isolate 对 Emscripten 状态不友好）
    pool: 'forks'
  }
})
