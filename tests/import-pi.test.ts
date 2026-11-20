import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileSkip, settingsFrom } from '../config'
import { batchPrompts, extractPiUserPrompts, findPiSessionFiles } from '../tools/import-pi'

const NOW = Date.UTC(2026, 9, 30, 12)

describe('import-pi', () => {
  test('extracts user prompts from Pi session JSONL and filters slash commands, short prompts, and skip patterns', () => {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-10-30T10:00:00Z', cwd: '/tmp' }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-10-30T10:00:01Z',
        message: { role: 'user', content: 'please fix this bug', timestamp: NOW - 10_000 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-10-30T10:00:02Z',
        message: { role: 'user', content: '/grammar stats', timestamp: NOW - 9_000 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: '2026-10-30T10:00:03Z',
        message: { role: 'user', content: 'ok', timestamp: NOW - 8_000 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'm4',
        parentId: 'm3',
        timestamp: '2026-10-30T10:00:04Z',
        message: { role: 'user', content: [{ type: 'text', text: 'deploy production now' }], timestamp: NOW - 7_000 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'm5',
        parentId: 'm4',
        timestamp: '2026-10-30T10:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ignored assistant reply' }], timestamp: NOW - 6_000 },
      }),
    ].join('\n')

    const found = extractPiUserPrompts(lines, {
      from: NOW - 86_400_000,
      to: NOW,
      settings: settingsFrom(),
      skipRegexes: compileSkip(['^deploy ']),
    })
    expect(found).toEqual([{ key: `${NOW - 10_000}\0please fix this bug`, text: 'please fix this bug', at: NOW - 10_000 }])
    expect(batchPrompts(found, 20).length).toBe(1)
  })

  test('findPiSessionFiles and --dry-run CLI discover Pi session files without making model calls', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-import-pi-'))
    try {
      const agentDir = join(tmp, 'agent')
      const sessDir = join(agentDir, 'sessions', '--proj--')
      mkdirSync(sessDir, { recursive: true })
      const sessFile = join(sessDir, '2026-10-30_s1.jsonl')
      writeFileSync(
        sessFile,
        [
          JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: new Date().toISOString(), cwd: '/tmp' }),
          JSON.stringify({
            type: 'message',
            id: 'u1',
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: 'user', content: 'i want fix this issue', timestamp: Date.now() - 1000 },
          }),
        ].join('\n'),
        'utf8',
      )

      expect(findPiSessionFiles(join(agentDir, 'sessions'), Date.now() - 60_000)).toEqual([sessFile])

      const stdout = execFileSync(
        join(process.cwd(), 'node_modules', '.bin', 'jiti'),
        ['tools/import-pi.ts', '--dry-run', '--sessions-dir', join(agentDir, 'sessions'), '--agent-dir', agentDir],
        { encoding: 'utf8' },
      )
      expect(stdout).toContain('1 prompts typed')
      expect(stdout).toContain('1 calls.')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
