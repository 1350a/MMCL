import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 部分环境（沙箱/代理）下 localhost 传输极慢，放宽超时避免误报
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
