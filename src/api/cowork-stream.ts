/**
 * cowork 帧 → OpenAI chat.completion.chunk 的映射（纯函数，便于单测）。
 *
 * 语义映射：
 *   component.content (c_text)          → delta.content
 *   component.content (c_reasoning)     → delta.reasoning_content
 *   component.content (c_execute_code…) → 不直接产出（工具调用在 component.end 一次性给全）
 *   component.start   (c_execute_code…) → 记录当前工具组件（brief），产出可选的 tool 提示
 *   component.end     (c_execute_code…) → 产出工具调用完成说明（代码 + 真实 output）
 *   run.end                             → 结束
 *
 * **设计取舍**：DSH 侧只认 content / reasoning_content 两个增量字段，没有标准
 * 的 tool_call 通道（灵犀的工具也不需要模型发起 —— 是它自己在沙箱里跑）。
 * 所以工具调用被渲染成一段**结构化的正文**（代码 + stdout），让用户看得见
 * 「它真的执行了」，而不是丢掉。
 */
import type { CoworkFrame, ToolFullContent } from './cowork.ts'

/** 组件语义 → 增量字段。 */
export type DeltaKind = 'content' | 'reasoning'

/** 一轮内的帧解析状态（跨帧记忆当前组件类型）。 */
export interface CoworkState {
  /** id → 组件类型（component.start 时登记）。 */
  components: Map<string, string>
  /** id → component.start 的 payload（如工具的 brief）。 */
  payloads: Map<string, Record<string, unknown>>
}

export function newCoworkState(): CoworkState {
  return { components: new Map(), payloads: new Map() }
}

/** 正文/思考增量。 */
export interface TextDelta {
  kind: DeltaKind
  text: string
}

/** 工具调用渲染（component.end）。 */
export interface ToolDelta {
  tool: string
  brief?: string
  code?: string
  output?: string
}

export type CoworkDelta = TextDelta | ToolDelta

export function isToolDelta(d: CoworkDelta): d is ToolDelta {
  return (d as ToolDelta).tool !== undefined
}

/** 哪些组件类型算「工具调用」。 */
export function isToolComponent(type: string): boolean {
  return (
    type === 'c_execute_code' ||
    type === 'c_read_file' ||
    type === 'c_write_file' ||
    type === 'c_edit_file' ||
    type === 'c_list_files' ||
    type === 'c_install_package' ||
    type === 'c_websearch' ||
    type === 'c_urlfetch'
  )
}

/** 组件类型 → 展示名。 */
export function toolLabel(type: string): string {
  switch (type) {
    case 'c_execute_code':
      return '执行代码'
    case 'c_read_file':
      return '读取文件'
    case 'c_write_file':
      return '写入文件'
    case 'c_edit_file':
      return '编辑文件'
    case 'c_list_files':
      return '列出文件'
    case 'c_install_package':
      return '安装依赖'
    case 'c_websearch':
      return '联网搜索'
    case 'c_urlfetch':
      return '抓取网页'
    default:
      return type.replace(/^c_/, '')
  }
}

/** 从 component.end 的 full_content 里抽工具参数（形状不固定，容错取）。 */
export function extractTool(full: unknown): { code?: string; output?: string; brief?: string } {
  if (full === null || typeof full !== 'object') return {}
  const f = full as ToolFullContent
  const out: { code?: string; output?: string; brief?: string } = {}
  const args = f.arguments
  if (args !== null && typeof args === 'object') {
    if (typeof args.code === 'string') out.code = args.code
    if (typeof args.brief === 'string') out.brief = args.brief
    // 文件类工具的路径 / 内容
    if (out.code === undefined) {
      for (const key of ['content', 'command', 'path', 'query', 'url']) {
        const v = (args as Record<string, unknown>)[key]
        if (typeof v === 'string' && v !== '') {
          out.code = v
          break
        }
      }
    }
  }
  if (typeof f.output === 'string') out.output = f.output
  return out
}

/**
 * 处理一帧，产出 0..n 个增量。
 *
 * 需要状态的帧（component.start 登记类型 / component.end 取 payload）请传入 `state`。
 */
export function frameToDeltas(frame: CoworkFrame, state: CoworkState): CoworkDelta[] {
  const d = frame.data
  if (d === undefined) return []
  const id = typeof d.id === 'string' ? d.id : ''
  switch (frame.event) {
    case 'component.start': {
      const type = typeof d.type === 'string' ? d.type : ''
      if (id !== '') {
        state.components.set(id, type)
        if (d.payload !== undefined && d.payload !== null) state.payloads.set(id, d.payload as Record<string, unknown>)
      }
      return []
    }
    case 'component.content': {
      const type = typeof d.type === 'string' ? d.type : (state.components.get(id) ?? '')
      const delta = typeof d.delta === 'string' ? d.delta : ''
      if (delta === '') return []
      if (type === 'c_text') return [{ kind: 'content', text: delta }]
      if (type === 'c_reasoning') return [{ kind: 'reasoning', text: delta }]
      // 工具的代码正文不在这里推（component.end 会给完整的，避免半截代码刷屏）
      return []
    }
    case 'component.end': {
      const type = typeof d.type === 'string' ? d.type : (state.components.get(id) ?? '')
      if (!isToolComponent(type)) return []
      const extracted = extractTool(d.full_content)
      const payload = state.payloads.get(id)
      const brief =
        extracted.brief ?? (typeof payload?.brief === 'string' ? (payload.brief as string) : undefined)
      const out: ToolDelta = { tool: type }
      if (brief !== undefined && brief !== '') out.brief = brief
      if (extracted.code !== undefined) out.code = extracted.code
      if (extracted.output !== undefined) out.output = extracted.output
      state.components.delete(id)
      state.payloads.delete(id)
      return [out]
    }
    default:
      return []
  }
}

/** 工具调用 → 展示用正文（Markdown）。 */
export function renderToolDelta(t: ToolDelta): string {
  const label = toolLabel(t.tool)
  const lines: string[] = []
  lines.push(`\n\n> 🔧 **${label}${t.brief !== undefined && t.brief !== '' ? `：${t.brief}` : ''}**\n`)
  if (t.code !== undefined && t.code !== '') {
    const fence = t.tool === 'c_execute_code' ? 'python' : ''
    lines.push(`\n\`\`\`${fence}\n${t.code.trimEnd()}\n\`\`\`\n`)
  }
  if (t.output !== undefined && t.output !== '') {
    lines.push(`\n**输出：**\n\n\`\`\`\n${t.output.trimEnd()}\n\`\`\`\n`)
  }
  lines.push('\n')
  return lines.join('')
}

/** 一轮是否结束（run.end）。 */
export function isRunEnd(frame: CoworkFrame): boolean {
  return frame.event === 'run.end'
}

/** 服务端主动报错时的消息（容错取）。 */
export function frameError(frame: CoworkFrame): string | undefined {
  if (frame.event !== 'error' && frame.event !== 'run.error') return undefined
  const d = frame.data
  if (d === undefined) return 'unknown error'
  for (const key of ['msg', 'message', 'error', 'result']) {
    const v = d[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return 'unknown error'
}

/** 取本轮的计费（run.end）。 */
export function frameCredit(frame: CoworkFrame): number | undefined {
  const v = frame.data?.session_credit_consumed ?? frame.data?.credit_consumed
  return typeof v === 'number' ? v : undefined
}
