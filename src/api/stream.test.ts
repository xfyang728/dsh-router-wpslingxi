/**
 * SSE 转换单测 —— 灵犀专家模式帧解析 / 增量映射 / 收尾（协议见 ./index.ts 顶部注释）。
 *
 * 协议要点：事件名（event 行）即语义类型，正文增量在 component.content 的 delta。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameError, frameToDelta, isEndFrame, openAiChunk, openAiFinal, parseSseFrames } from './stream.ts'

test('parseSseFrames: 取 event: 名 + data: JSON', () => {
  const raw =
    'event: component.start\n' +
    'data: {"component_id":"c1","component_type":"TEXT_BLOCK"}\n\n' +
    'event: component.content\n' +
    'data: {"component_id":"c1","delta":"你好"}\n\n'
  const { frames, rest } = parseSseFrames(raw)
  assert.equal(frames.length, 2)
  assert.equal(frames[0]!.event, 'component.start')
  assert.equal(frames[0]!.payload?.component_type, 'TEXT_BLOCK')
  assert.equal(frames[1]!.payload?.delta, '你好')
  assert.equal(rest, '')
})

test('parseSseFrames: 半帧留在 rest', () => {
  const raw = 'event: run.start\ndata: {"run_id":"r1"}\n\nevent: component.content\ndata: {"delta":"te'
  const { frames, rest } = parseSseFrames(raw)
  assert.equal(frames.length, 1)
  assert.equal(rest, 'event: component.content\ndata: {"delta":"te')
})

test('parseSseFrames: :keepalive 注释行不产帧', () => {
  const raw = ':keepalive\n\n' + 'event: run.end\ndata: {"run_id":"r1"}\n\n'
  const { frames } = parseSseFrames(raw)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.event, 'run.end')
})

test('parseSseFrames: event:finish（无 data）也产帧；非 JSON / [DONE] 跳过', () => {
  const raw = 'event: finish\ndata:\n\n' + 'event: ping\ndata: not json\n\n' + 'data: [DONE]\n\n'
  const { frames } = parseSseFrames(raw)
  // finish 帧无 data → payload undefined；ping 帧有名字但 data 非 JSON → 也产帧但同样无 payload；
  // 纯 data: [DONE] 行不带 event 且非 JSON → 不产帧。
  assert.equal(frames.length, 2)
  assert.equal(frames[0]!.event, 'finish')
  assert.equal(frames[0]!.payload, undefined)
  assert.equal(frames[1]!.event, 'ping')
  assert.equal(frames[1]!.payload, undefined)
})

test('frameToDelta: component.content 的 delta 直接作为正文增量', () => {
  const chunks: string[] = []
  for (const t of ['你', '好', '世界']) {
    const d = frameToDelta({ event: 'component.content', payload: { component_id: 'c1', delta: t }, raw: '' })
    assert.notEqual(d, null)
    chunks.push(d!.content!)
  }
  assert.equal(chunks.join(''), '你好世界')
})

test('frameToDelta: 空 delta / 非 component.content 事件不产 delta', () => {
  assert.equal(frameToDelta({ event: 'component.content', payload: { delta: '' }, raw: '' }), null)
  assert.equal(frameToDelta({ event: 'component.start', payload: { component_type: 'TEXT_BLOCK' }, raw: '' }), null)
  assert.equal(frameToDelta({ event: 'run.end', payload: { run_id: 'r1' }, raw: '' }), null)
  assert.equal(
    frameToDelta({ event: 'execution', payload: { data: { user_request: { content: 'x' } }, type: 'user' }, raw: '' }),
    null,
  )
})

test('isEndFrame: 只有 event:finish 算结束', () => {
  assert.equal(isEndFrame({ event: 'finish', payload: undefined, raw: '' }), true)
  assert.equal(isEndFrame({ event: 'run.end', payload: { run_id: 'r1' }, raw: '' }), false)
  assert.equal(isEndFrame({ event: 'turn.end', payload: {}, raw: '' }), false)
})

test('frameError: event:error 报错', () => {
  assert.equal(frameError({ event: 'error', payload: { msg: '参数错误' }, raw: '' }), '参数错误')
  assert.equal(frameError({ event: 'component.content', payload: { delta: 'x' }, raw: '' }), undefined)
})

test('openAiChunk / openAiFinal 形状', () => {
  const chunk = JSON.parse(openAiChunk('id1', 'plan_pro', { content: 'hi' }).slice(6).trim())
  assert.equal(chunk.object, 'chat.completion.chunk')
  assert.equal(chunk.choices[0].delta.content, 'hi')
  const fin = JSON.parse(openAiFinal('id1', 'plan_pro').slice(6).trim())
  assert.equal(fin.choices[0].finish_reason, 'stop')
})
