/**
 * 灵犀 SSE → OpenAI SSE 转换（协议见 ./index.ts 顶部注释）。
 *
 * 只有**专家模式**通道（/expert_completion）会产生有意义的流，其帧形如：
 *
 *     event:<name>\n
 *     data:<json>\n\n
 *
 * **事件名（event 行）才是语义类型**，data 里没有 type 字段：
 *
 *   execution          → { data:{user_request:{content}}, type:"user" }  回声，忽略
 *   run.start          → { run_id }
 *   turn.start         → { turn_id, agent_id, location_type }
 *   component.start    → { component_id, component_type }（TEXT_BLOCK 等）
 *   component.content  → { component_id, delta }   ← **正文增量**
 *   component.end      → { component_id, full_content, component_type }
 *   turn.end           → { turn_id, agent_id, agent_time }
 *   run.end            → { run_id }
 *   finish             → 空 data，流终止
 *
 * 流里还混着 `:keepalive` 注释行（无 event/data），必须忽略。
 */

/** 灵犀一条事件的 data 载荷（字段随事件名变化）。 */
export interface LingxiPayload {
  /** execution 回声。 */
  data?: unknown
  type?: string
  /** component.content 的正文增量。 */
  delta?: string
  /** component.end 的整段全文。 */
  full_content?: string
  component_id?: string
  component_type?: string
  turn_id?: string
  agent_id?: string
  run_id?: string
  [k: string]: unknown
}

/** 解析出的一个 SSE 帧：事件名 + 已 JSON.parse 的 data 载荷。 */
export interface LingxiFrame {
  event: string
  payload: LingxiPayload | undefined
  raw: string
}

/**
 * 从缓冲区里切出完整 SSE 帧。
 *
 * SSE 规范用空行分帧；兼容 \r\n；`:keepalive` 注释行不产帧。
 * 返回未被消费的尾部（半帧）留给下一轮拼接。
 */
export function parseSseFrames(buffer: string): { frames: LingxiFrame[]; rest: string } {
  const frames: LingxiFrame[] = []
  let rest = buffer
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest)
    if (m === null) break
    const frame = rest.slice(0, m.index)
    rest = rest.slice(m.index + m[0].length)
    eventFromFrame(frame, frames)
  }
  return { frames, rest }
}

/** 解析单个帧文本并推入 frames（无 event 且无 data 则不产帧）。 */
function eventFromFrame(frame: string, frames: LingxiFrame[]): void {
  let event = ''
  let payload: LingxiPayload | undefined
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith(':')) continue // :keepalive 等注释
    if (trimmed.startsWith('event:')) {
      event = trimmed.slice(6).trim()
      continue
    }
    if (!trimmed.startsWith('data:')) continue
    const body = trimmed.slice(5).trim()
    if (body === '' || body === '[DONE]') continue
    try {
      payload = JSON.parse(body) as LingxiPayload
    } catch {
      // 非 JSON data 行忽略
    }
  }
  if (event !== '' || payload !== undefined) {
    frames.push({ event, payload, raw: frame })
  }
}

/** OpenAI chat.completion.chunk（增量）。 */
export function openAiChunk(
  id: string,
  model: string,
  delta: { content?: string; reasoning_content?: string },
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`
}

/** OpenAI 收尾 chunk。 */
export function openAiFinal(id: string, model: string): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`
}

/**
 * 一帧 → OpenAI delta。返回 null = 本帧无正文（应忽略）。
 *
 * 正文只来自 `component.content` 的 `delta`（已是增量，无需差分）。
 */
export function frameToDelta(frame: LingxiFrame): { content?: string; reasoning_content?: string } | null {
  if (frame.event !== 'component.content') return null
  const delta = frame.payload?.delta
  if (typeof delta !== 'string' || delta === '') return null
  return { content: delta }
}

/** 是否为「本轮结束」帧：event:finish 即流终止。 */
export function isEndFrame(frame: LingxiFrame): boolean {
  return frame.event === 'finish'
}

/** 是否为错误帧（灵犀在参数错误时回 event:error）。 */
export function frameError(frame: LingxiFrame): string | undefined {
  if (frame.event !== 'error') return undefined
  const p = frame.payload as { result?: string; msg?: string; message?: string } | undefined
  return p?.msg ?? p?.message ?? p?.result ?? 'lingxi stream error'
}
