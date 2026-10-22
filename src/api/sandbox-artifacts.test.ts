/**
 * sandbox-artifacts 单测 —— 全部离线（注入 fetch 替身）。
 *
 * 覆盖：prompt 约定的幂等性、目录项展开（服务端把子文件嵌在父项里）、
 * 路径穿越防护、失败不致命、摘要渲染。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARTIFACT_INSTRUCTION,
  SANDBOX_OUTPUT_DIR,
  pullSandboxArtifacts,
  renderPullSummary,
  withArtifactInstruction,
} from './sandbox-artifacts.ts'

const realFetch = globalThis.fetch

/** 用一个假 fetch 跑一段逻辑，结束后还原。 */
async function withFetch<T>(fn: typeof fetch, body: () => Promise<T>): Promise<T> {
  globalThis.fetch = fn
  try {
    return await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lingxi-art-'))
}

test('withArtifactInstruction: 追加约定，且重复调用不叠加', () => {
  const once = withArtifactInstruction('写个快排')
  assert.ok(once.startsWith('写个快排'))
  assert.ok(once.includes(SANDBOX_OUTPUT_DIR))
  assert.ok(once.includes(ARTIFACT_INSTRUCTION))
  // 幂等：已含目录就不再追加
  const twice = withArtifactInstruction(once)
  assert.equal(twice, once)
  assert.equal(twice.split('系统约定').length - 1, 1)
})

test('pullSandboxArtifacts: 列出 → 取直链 → 下载 → 落盘', async () => {
  const dest = tempDir()
  try {
    const calls: string[] = []
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                { name: '.rundata', type: 'dir', key: '/home/lingxi/workspace/.rundata/' },
                {
                  name: 'output',
                  type: 'dir',
                  key: '/home/lingxi/workspace/output/',
                  // 服务端把子文件嵌在父项里 —— 必须展开
                  files: [
                    { name: 'a.py', size: 5, type: 'file', key: '/home/lingxi/workspace/output/a.py' },
                    { name: 'b.txt', size: 3, type: 'file', key: '/home/lingxi/workspace/output/b.txt' },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/sandbox/file/preview')) {
        const body = JSON.parse(String(init?.body)) as { key: string }
        return new Response(JSON.stringify({ data: { url: 'https://oss.test/dl?key=' + encodeURIComponent(body.key) } }), {
          status: 200,
        })
      }
      if (u.startsWith('https://oss.test/dl')) {
        const key = decodeURIComponent(new URL(u).searchParams.get('key') ?? '')
        return new Response(key.endsWith('a.py') ? 'print' : 'abc', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const logs: string[] = []
    const res = await withFetch(fake, () =>
      pullSandboxArtifacts('sid', 'sess-1', dest, (m) => logs.push(m)),
    )
    assert.equal(res.seen, 2)
    assert.equal(res.saved.length, 2)
    assert.deepEqual(res.failed, [])
    assert.equal(readFileSync(join(dest, 'a.py'), 'utf8'), 'print')
    assert.equal(readFileSync(join(dest, 'b.txt'), 'utf8'), 'abc')
    assert.deepEqual(readdirSync(dest).sort(), ['a.py', 'b.txt'])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('pullSandboxArtifacts: 目录为空 → 什么都不做，不建目录', async () => {
  const dest = join(tempDir(), 'nested', 'deep')
  const fake = (async () => new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })) as unknown as typeof fetch
  const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
  assert.equal(res.seen, 0)
  assert.equal(res.saved.length, 0)
  // 没有文件就不该创建目录
  assert.throws(() => readdirSync(dest))
})

test('pullSandboxArtifacts: 下载失败只记入 failed，不抛', async () => {
  const dest = tempDir()
  try {
    const fake = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({ data: { items: [{ name: 'x.py', type: 'file', key: '/home/lingxi/workspace/output/x.py' }] } }),
          { status: 200 },
        )
      }
      // preview 挂掉
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
    const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
    assert.equal(res.seen, 1)
    assert.equal(res.saved.length, 0)
    assert.deepEqual(res.failed, ['x.py'])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('pullSandboxArtifacts: 文件名的反斜杠被剥掉，文件仍落在目标目录内', async () => {
  const dest = tempDir()
  try {
    const fake = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({
            data: { items: [{ name: 'sub\\win.py', type: 'file', key: '/home/lingxi/workspace/output/win.py' }] },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/sandbox/file/preview')) {
        return new Response(JSON.stringify({ data: { url: 'https://oss.test/w' } }), { status: 200 })
      }
      return new Response('win', { status: 200 })
    }) as unknown as typeof fetch
    const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
    assert.equal(res.saved.length, 1)
    assert.equal(res.saved[0]!.name, 'win.py')
    assert.deepEqual(readdirSync(dest), ['win.py'])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('pullSandboxArtifacts: 文件名的正斜杠同样被剥掉', async () => {
  const dest = tempDir()
  try {
    const fake = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({
            data: { items: [{ name: '../evil.py', type: 'file', key: '/home/lingxi/workspace/output/evil.py' }] },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/sandbox/file/preview')) {
        return new Response(JSON.stringify({ data: { url: 'https://oss.test/x' } }), { status: 200 })
      }
      return new Response('evil', { status: 200 })
    }) as unknown as typeof fetch
    const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
    assert.equal(res.saved.length, 1)
    assert.equal(res.saved[0]!.name, 'evil.py')
    assert.deepEqual(readdirSync(dest), ['evil.py'])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('pullSandboxArtifacts: 目录不存在会被创建', async () => {
  const base = tempDir()
  const dest = join(base, 'made', 'up')
  try {
    const fake = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({ data: { items: [{ name: 'c.py', type: 'file', key: '/home/lingxi/workspace/output/c.py' }] } }),
          { status: 200 },
        )
      }
      if (u.includes('/sandbox/file/preview')) {
        return new Response(JSON.stringify({ data: { url: 'https://oss.test/c' } }), { status: 200 })
      }
      return new Response('cc', { status: 200 })
    }) as unknown as typeof fetch
    const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
    assert.equal(res.saved.length, 1)
    assert.equal(readFileSync(join(dest, 'c.py'), 'utf8'), 'cc')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('renderPullSummary: 有产出才渲染，失败也标注', () => {
  assert.equal(renderPullSummary({ saved: [], failed: [], seen: 0 }, '/tmp'), '')
  const md = renderPullSummary({ saved: [{ key: 'k', name: 'a.py', size: 12 }], failed: ['b.py'], seen: 2 }, '/tmp/out')
  assert.ok(md.includes('沙箱产出已回传到本机'))
  assert.ok(md.includes('`/tmp/out`'))
  assert.ok(md.includes('a.py'))
  assert.ok(md.includes('12 字节'))
  assert.ok(md.includes('b.py'))
  assert.ok(md.includes('下载失败'))
})

test('pullSandboxArtifacts: 二进制内容不被当文本损坏', async () => {
  const dest = tempDir()
  try {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
    const fake = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sandbox/sessions/')) {
        return new Response(
          JSON.stringify({ data: { items: [{ name: 'bin.dat', type: 'file', key: '/home/lingxi/workspace/output/bin.dat' }] } }),
          { status: 200 },
        )
      }
      if (u.includes('/sandbox/file/preview')) {
        return new Response(JSON.stringify({ data: { url: 'https://oss.test/bin' } }), { status: 200 })
      }
      return new Response(bytes, { status: 200 })
    }) as unknown as typeof fetch
    const res = await withFetch(fake, () => pullSandboxArtifacts('sid', 's', dest, () => {}))
    assert.equal(res.saved.length, 1)
    assert.deepEqual([...readFileSync(join(dest, 'bin.dat'))], [...bytes])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
