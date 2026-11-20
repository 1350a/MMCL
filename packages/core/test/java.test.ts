import { describe, expect, it } from 'vitest'
import {
  assertJavaCompatible,
  detectJava,
  JavaNotFoundError,
  JavaVersionMismatchError,
  parseJavaVersionText
} from '../src'
import type { VersionJson } from '../src'

describe('parseJavaVersionText', () => {
  it('解析新旧两种命名', () => {
    expect(parseJavaVersionText('java version "1.8.0_381"')?.majorVersion).toBe(8)
    expect(parseJavaVersionText('openjdk version "17.0.9"')?.majorVersion).toBe(17)
    expect(parseJavaVersionText('openjdk version "21"')?.majorVersion).toBe(21)
    expect(parseJavaVersionText('java version "1.5.0_22"')?.majorVersion).toBe(5)
  })

  it('无 version 字符串返回 undefined', () => {
    expect(parseJavaVersionText('command not found')).toBeUndefined()
  })
})

describe('detectJava', () => {
  it('本机 PATH 上的 java 可探测（冒烟）', async () => {
    const info = await detectJava()
    expect(info.majorVersion).toBeGreaterThanOrEqual(5)
    expect(info.raw).toBeTruthy()
  }, 30_000)

  it('显式路径不存在时回退 PATH 上的 java', async () => {
    const info = await detectJava('C:/definitely/not/java.exe')
    expect(info.majorVersion).toBeGreaterThanOrEqual(5)
    expect(info.path).toBe('java')
  }, 30_000)
})

describe('assertJavaCompatible', () => {
  it('版本不足抛 JavaVersionMismatchError（如 Java 8 跑需要 17 的版本）', () => {
    const versionJson = { javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 } } as VersionJson
    expect(() =>
      assertJavaCompatible({ path: 'java', majorVersion: 8, raw: '1.8.0_381' }, versionJson)
    ).toThrow(JavaVersionMismatchError)
    expect(() =>
      assertJavaCompatible({ path: 'java', majorVersion: 17, raw: '17.0.9' }, versionJson)
    ).not.toThrow()
  })

  it('版本 JSON 无 javaVersion 时不校验', () => {
    expect(() =>
      assertJavaCompatible({ path: 'java', majorVersion: 5, raw: '1.5.0' }, {} as VersionJson)
    ).not.toThrow()
  })
})
