/**
 * 供应商层单测 —— 全部离线（不真连 lingxi.wps.cn）：
 * addApiKey 校验失败路径、unknown model、bad_request、chatOnce 流转换（mock fetch）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setWsConnector, WpslingxiSupplier, type LingxiAccount } from './supplier.ts'
import type { SupplierEnv } from '../contract.ts'

/** 极简假 env（store/credentials 内存版）。 */
function fakeEnv(): SupplierEnv & { creds: Map<string, LingxiAccount> } {
  const creds = new Map<string, LingxiAccount>()
  let uidSeq = 0
  const env: SupplierEnv = {
    dataDir: '/tmp/wpslingxi-test',
    log: () => {},
    store: {
      get: () => ({ alias: 'wl', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
      setAlias: () => {},
      setPoolOrder: () => {},
      setPoolStrategy: () => {},
      setModelEnabled: () => {},
      addCustomModel: () => {},
      removeCustomModel: () => {},
      setAllModelsEnabled: () => {},
      getCredits: () => -1,
      putCredits: (_id, _uid, v) => v,
      clearCredits: () => {},
    },
    credentials: {
      list: () => [...creds.keys()],
      get: <T,>(_sid: string, uid: string) => creds.get(uid) as T | undefined,
      save: (_sid, uid, blob) => { creds.set(uid, blob as LingxiAccount) },
      remove: (_sid, uid) => { creds.delete(uid) },
    },
  }
  return Object.assign(env, { creds })
}

/** mock 全局 fetch。 */
function mockFetch(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => fn(String(url), init)) as typeof fetch
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('addApiKey: 空 sid 拒绝；identity 401 → 无效', async () => {
  const env = fakeEnv()
  const s = new WpslingxiSupplier(env)
  const empty = await s.addApiKey({ name: '', apiKey: '  ' })
  assert.equal(empty.ok, false)
  mockFetch(() => new Response('{"result":"UserUnauthorized"}', { status: 401 }))
  const bad = await s.addApiKey({ name: 'x', apiKey: 'abc' })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /无效/)
})

test('addApiKey: identity 200 → 存凭证，返回 uid', async () => {
  const env = fakeEnv()
  const s = new WpslingxiSupplier(env)
  mockFetch((url) => {
    assert.match(url, /assistant\/identity/)
    return new Response('{"data":{}}', { status: 200 })
  })
  const ok = await s.addApiKey({ name: '测试', apiKey: ' sid123 ' })
  assert.equal(ok.ok, true)
  assert.equal(ok.account?.uid, 'sid-1')
  assert.equal(env.creds.get('sid-1')?.wpsSid, 'sid123')
  assert.equal(env.creds.get('sid-1')?.name, '测试')
})

test('chatOnce: unknown model → no_such_model（不惩罚账号）', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockFetch((url) => {
    if (url.includes('/sessions/plans')) {
      return new Response(JSON.stringify({ data: { plans: [{ key: 'plan_pro' }] } }), { status: 200 })
    }
    throw new Error('should not reach ' + url)
  })
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"hi"}]}', stream: true, model: 'wl/nope' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.state, 'no_such_model')
})

test('chatOnce: 空 user 消息 → bad_request', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockFetch(() => new Response(JSON.stringify({ data: { plans: [] } }), { status: 200 }))
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[]}', stream: true, model: 'plan_pro' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.state, 'bad_request')
})

/** 假 WebSocket：测试可手动喂帧。 */
class FakeWs {
  readyState = 0
  sent: string[] = []
  private listeners = new Map<string, Array<(ev: unknown) => void>>()
  constructor() {
    // 模拟异步 open
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open', {})
    })
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit('close', { code: 1000, reason: '', wasClean: true })
  }
  /** 测试辅助：喂一帧。 */
  push(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }
  /** 测试辅助：服务端关闭。 */
  serverClose(): void {
    this.close()
  }
}

/** 让 chatOnce 用上假 WS，并返回它。 */
function useFakeWs(): FakeWs {
  const fake = new FakeWs()
  setWsConnector(() => fake as unknown as WebSocket)
  return fake
}

/** 读完整流，返回所有 OpenAI delta。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let all = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    all += dec.decode(value, { stream: true })
  }
  return [...all.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!))
}

/** cowork 会话端点 + plans 的通用 mock。 */
function mockCoworkFetch(sessionStatus = 200): void {
  mockFetch((url) => {
    if (url.includes('/cowork/sessions') && url.endsWith('/sessions')) {
      if (sessionStatus !== 200) return new Response('{"result":"UserUnauthorized"}', { status: sessionStatus })
      return new Response(JSON.stringify({ data: { session_id: 'cowork-1' }, result: 'ok' }), { status: 200 })
    }
    if (url.includes('/sessions/plans')) {
      return new Response(JSON.stringify({ data: { plans: [{ key: 'plan_pro' }], models: [{ key: 'qwen3.8_flash' }] } }), { status: 200 })
    }
    throw new Error('unexpected ' + url)
  })
}

test('chatOnce(cowork): c_reasoning → reasoning_content，c_text → content，run.end 收尾', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockCoworkFetch()
  const ws = useFakeWs()
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"hi"}]}', stream: true, model: 'qwen3.8_flash' })
  assert.equal(r.ok, true)
  if (!r.ok || !('stream' in r)) return
  // 喂帧（模拟真实时序：先思考、再正文、再 run.end）
  ws.push({ event: 'user.input', data: { group_id: 'g1' } })
  ws.push({ event: 'run.start', data: { id: 'r1' } })
  ws.push({ event: 'component.start', data: { type: 'c_reasoning', id: 'c1' } })
  ws.push({ event: 'component.content', data: { type: 'c_reasoning', id: 'c1', delta: '想想' } })
  ws.push({ event: 'component.end', data: { type: 'c_reasoning', id: 'c1', full_content: '想想' } })
  ws.push({ event: 'component.start', data: { type: 'c_text', id: 'c2' } })
  ws.push({ event: 'component.content', data: { type: 'c_text', id: 'c2', delta: '你' } })
  ws.push({ event: 'component.content', data: { type: 'c_text', id: 'c2', delta: '好' } })
  ws.push({ event: 'component.end', data: { type: 'c_text', id: 'c2', full_content: '你好' } })
  ws.push({ event: 'run.end', data: { id: 'r1', credit_consumed: 1, session_credit_consumed: 1 } })
  const deltas = await drain(r.stream)
  const reasoning = deltas.map((d) => (d.choices as any)?.[0]?.delta?.reasoning_content).filter((c) => c !== undefined)
  const content = deltas.map((d) => (d.choices as any)?.[0]?.delta?.content).filter((c) => c !== undefined)
  assert.deepEqual(reasoning, ['想想'])
  assert.deepEqual(content, ['你', '好'])
  assert.ok(deltas.some((d) => (d.choices as any)?.[0]?.finish_reason === 'stop'), 'finish_reason=stop')
  // 发出的 user.input 里应当带上模型
  assert.equal(ws.sent.length, 1)
  const sent = JSON.parse(ws.sent[0]!)
  assert.equal(sent.event, 'user.input')
  // 用户原文会被追加「产出目录」约定（Agent 不给路径就不落盘，实测）
  assert.ok(String(sent.data.agent_input.text).startsWith('hi'), 'text 以用户原文开头')
  assert.ok(String(sent.data.agent_input.text).includes('/home/lingxi/workspace/output'), 'text 含产出目录约定')
  assert.equal(sent.data.agent_input.expect_model, 'qwen3.8_flash')
})

test('chatOnce(cowork): c_execute_code → 渲染代码 + 真实 output', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockCoworkFetch()
  const ws = useFakeWs()
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"跑个代码"}]}', stream: true, model: 'qwen3.8_flash' })
  assert.equal(r.ok, true)
  if (!r.ok || !('stream' in r)) return
  ws.push({ event: 'component.start', data: { type: 'c_execute_code', id: 'e1', payload: { brief: '实现快速排序' } } })
  ws.push({ event: 'component.content', data: { type: 'c_execute_code', id: 'e1', delta: 'def f(): pass' } })
  ws.push({
    event: 'component.end',
    data: {
      type: 'c_execute_code',
      id: 'e1',
      full_content: { arguments: { code: 'print(1+1)', brief: '实现快速排序' }, output: '2\n' },
    },
  })
  ws.push({ event: 'run.end', data: { id: 'r1' } })
  const deltas = await drain(r.stream)
  const content = deltas.map((d) => (d.choices as any)?.[0]?.delta?.content).filter((c) => c !== undefined).join('')
  assert.match(content, /执行代码/)
  assert.match(content, /print\(1\+1\)/)
  assert.match(content, /2/)
  // 工具代码正文不应当在 component.content 阶段就被推出去（避免半截代码）
  assert.equal(content.includes('def f(): pass'), false)
})

test('chatOnce(cowork): 大量无产出帧后仍有正文 —— 不能卡死', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockCoworkFetch()
  const ws = useFakeWs()
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"hi"}]}', stream: true, model: 'qwen3.8_flash' })
  assert.equal(r.ok, true)
  if (!r.ok || !('stream' in r)) return
  // 100 个无产出帧打头
  for (let i = 0; i < 100; i++) ws.push({ event: 'component.start', data: { type: 'c_recommend', id: 'x' + i } })
  ws.push({ event: 'component.start', data: { type: 'c_text', id: 't1' } })
  ws.push({ event: 'component.content', data: { type: 'c_text', id: 't1', delta: '答案' } })
  ws.push({ event: 'run.end', data: { id: 'r1' } })
  const deltas = await drain(r.stream)
  const content = deltas.map((d) => (d.choices as any)?.[0]?.delta?.content).filter((c) => c !== undefined)
  assert.deepEqual(content, ['答案'])
})

test('chatOnce(cowork): 服务端主动关闭（无 run.end）→ 也要正常结束', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockCoworkFetch()
  const ws = useFakeWs()
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"hi"}]}', stream: true, model: 'qwen3.8_flash' })
  assert.equal(r.ok, true)
  if (!r.ok || !('stream' in r)) return
  ws.push({ event: 'component.start', data: { type: 'c_text', id: 't1' } })
  ws.push({ event: 'component.content', data: { type: 'c_text', id: 't1', delta: '半路' } })
  // 直接关闭：没有 run.end
  setTimeout(() => ws.serverClose(), 5)
  const deltas = await drain(r.stream)
  const content = deltas.map((d) => (d.choices as any)?.[0]?.delta?.content).filter((c) => c !== undefined)
  assert.deepEqual(content, ['半路'])
  assert.ok(deltas.some((d) => (d.choices as any)?.[0]?.finish_reason === 'stop'))
})

test('chatOnce: 建 cowork 会话 401 → session_dead', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  mockCoworkFetch(401)
  const r = await s.chatOnce('sid-1', 'auto', { rawBody: '{"messages":[{"role":"user","content":"hi"}]}', stream: true, model: 'qwen3.8_flash' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.state, 'session_dead')
})


test('removeLink: 删凭证', async () => {
  const env = fakeEnv()
  env.creds.set('sid-1', { name: 'a', wpsSid: 'x' })
  const s = new WpslingxiSupplier(env)
  assert.equal(await s.removeLink('sid-1'), true)
  assert.equal(await s.removeLink('sid-1'), false)
})