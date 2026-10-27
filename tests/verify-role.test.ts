import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const skillPaths = [
  path.join(process.cwd(), 'templates', 'skills', 'openspec-verify-change', 'SKILL.md'),
  path.join(process.cwd(), '.harness', 'skills', 'openspec-verify-change', 'SKILL.md'),
]

function readSkill(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\s+/gu, ' ')
}

describe('OpenSpec Verify role boundaries', () => {
  it('keeps Full on Final Verification while limiting the official triad to fallback schemas', () => {
    const [template, harness] = skillPaths.map(readSkill)
    expect(harness).toBe(template)
    expect(template).toContain('Full 的 `Final Verification` 是唯一执行计划')
    expect(template).toContain('Verify 只执行该计划')
    expect(template).toContain('PASS/FAIL/BLOCKED')
    expect(template).toContain('optional 缺口')
    expect(template).toContain('仅当其他 schema 未提供专属 verify artifact/instruction 时使用本框架')
    expect(template).toContain('不得追加官方三维映射评分')
    expect(template).toContain('二次 code review 或推测出的检查')
    expect(template).not.toContain('同时用三维框架检查遗漏')
  })

  it('retains the Full review and verification gates', () => {
    const template = readSkill(skillPaths[0])
    for (const invariant of [
      '全部实现 checkbox 为 `[x]`',
      '`Final Review` 必须绑定同一指纹',
      'NOT_RUN',
      '旧 Full tasks 没有 Final Verification',
      '没有可恢复 required 检查时询问',
      '从 Apply 调用时',
      '独立 Verify 只报告，不静默修复',
      '检查后再次运行指纹脚本',
    ]) {
      expect(template).toContain(invariant)
    }
    expect(template).toContain('不得生成 retrospective')
    expect(template).toContain('PR 或清理动作')
    expect(template).toContain('只有三维 fallback 报告才汇总三维状态')
    expect(template).not.toContain('报告摘要应覆盖三维')
  })

  it('leaves Lite behavior explicit and unchanged', () => {
    const template = readSkill(skillPaths[0])
    expect(template).toContain('不创建 `verify.md`')
    expect(template).toContain('不改变 Lite 归档条件')
  })
})
