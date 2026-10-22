/**
 * 灵犀 **cowork** 通道 —— WebSocket，专家模式的真身（2026-10 真机实测）。
 *
 * 为什么是这条通道（实测对比）：
 *
 *   | 通道                                  | 思考 c_reasoning | 工具调用 c_execute_code | 劫持成 research |
 *   |---------------------------------------|------------------|-------------------------|-----------------|
 *   | aigc /completions（老直答）            | ✗                | ✗                       | ✗               |
 *   | aigc /expert_completion（SSE）         | ✗（实测不推）     | ✗                       | ✔ 会进研究流水线 |
 *   | **aioffice /cowork/sandbox/.../ws**    | **✔**            | **✔ 真沙箱执行**         | ✗               |
 *
 * 只有 cowork 这条同时给出「思考 + 工具调用 + 真执行」，所以供应商的实现走它。
 *
 * 协议：
 *
 *   1) 建会话（注意 host 是 lingxi.kdocs.cn，与 aigc 的 lingxi.wps.cn 不同，
 *      但**同一个 wps_sid cookie 两边都认**，实测 200）：
 *        POST /api/aioffice/v1/cowork/sessions   body {}
 *        → {"data":{"session_id":"11972152822268104"},"result":"ok","v7code":0}
 *
 *   2) 连 WebSocket：
 *        wss://lingxi.kdocs.cn/api/aioffice/v1/cowork/sessions/{id}/sandbox/completions/ws
 *      Cookie 走握手头，Origin 必须是 https://lingxi.kdocs.cn（服务端按 origin 放行）。
 *
 *   3) 发一条 user.input 开始一轮：
 *        {"event":"user.input","data":{
 *           "agent_input":{ text, files:[], refs:[], expect_model, reasoning_effort,
 *                           current_mode, permission_mode, browser_plugin_enabled,
 *                           file_ids:[], upload_ids:[] },
 *           "headers":{"client_type":"pc_web","open_position":"copilotchat_web"}}}
 *
 *   4) 服务端回一串 JSON 文本帧（每帧一条），形如 {"event":"...","data":{...}}：
 *        user.input        回声
 *        run.start         {id, group_id}
 *        component.start   {type, id, parent_id, group_id}        组件开始
 *        component.content {type, id, delta}                      增量
 *        component.end     {type, id, full_content}               完整内容
 *        turn.start/turn.end  {type, id, agent_time}
 *        run.end           {id, credit_consumed, session_credit_consumed}
 *      结束后服务端主动 CLOSE(1000)。
 *
 *      组件的 `data.type` 决定语义 —— **这是与 SSE 通道最大的区别**：
 *        c_reasoning      思考（→ reasoning_content）
 *        c_text           正文（→ content）
 *        c_execute_code   工具：跑代码，full_content={arguments:{code,brief}, output}
 *        c_read_file / c_write_file / c_edit_file / c_list_files  文件工具
 *        c_install_package 装包
 *        c_websearch / c_urlfetch       联网
 *        c_recommend      追问推荐（忽略）
 */

/** Web 版 cowork 后端 host（与 aigc 的 lingxi.wps.cn 不同，但共用 cookie）。 */
export const COWORK_BASE = 'https://lingxi.kdocs.cn'

/** cowork 会话端点。 */
export const COWORK_SESSIONS_URL = `${COWORK_BASE}/api/aioffice/v1/cowork/sessions`

/** 桌面端/Web 的 UA（服务端对 UA 不敏感，但保持一致减少风险）。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/** cowork 请求头（HTTP 部分）。 */
export function coworkHeaders(sid: string): Record<string, string> {
  return {
    Cookie: `wps_sid=${sid}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: COWORK_BASE,
    Referer: `${COWORK_BASE}/`,
  }
}

/** WebSocket 握手头。 */
export function coworkWsHeaders(sid: string): Record<string, string> {
  return { Cookie: `wps_sid=${sid}`, Origin: COWORK_BASE, 'User-Agent': UA }
}

/** 建 cowork 会话。 */
export async function createCoworkSession(
  sid: string,
  timeoutMs = 30000,
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; body: string }> {
  let resp: Response
  try {
    resp = await fetch(COWORK_SESSIONS_URL, {
      method: 'POST',
      headers: coworkHeaders(sid),
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message }
  }
  const text = await resp.text().catch(() => '')
  if (!resp.ok) return { ok: false, status: resp.status, body: text.slice(0, 300) }
  try {
    const json = JSON.parse(text) as { data?: { session_id?: string } }
    const id = json.data?.session_id
    if (id === undefined || id === '') {
      return { ok: false, status: resp.status, body: `no session_id: ${text.slice(0, 300)}` }
    }
    return { ok: true, sessionId: id }
  } catch {
    return { ok: false, status: resp.status, body: `bad json: ${text.slice(0, 300)}` }
  }
}

/** 组件语义类型（`component.*` 帧的 data.type）。 */
export type ComponentType =
  | 'c_text'
  | 'c_reasoning'
  | 'c_execute_code'
  | 'c_read_file'
  | 'c_write_file'
  | 'c_edit_file'
  | 'c_list_files'
  | 'c_install_package'
  | 'c_websearch'
  | 'c_urlfetch'
  | 'c_recommend'
  | 'c_image_container'
  | (string & {})

/** 服务端帧（一行一条 JSON）。 */
export interface CoworkFrame {
  event: string
  data?: {
    type?: ComponentType
    id?: string
    parent_id?: string
    group_id?: string
    /** 增量（component.content）。 */
    delta?: string
    /** 完整内容（component.end）：字符串，或工具调用的对象。 */
    full_content?: unknown
    /** component.start 附带（如工具调用的 brief）。 */
    payload?: { brief?: string; [k: string]: unknown }
    /** run.end 计费。 */
    credit_consumed?: number
    session_credit_consumed?: number
    agent_time?: number
    [k: string]: unknown
  }
}

/** 工具调用的 full_content 形状（c_execute_code 等）。 */
export interface ToolFullContent {
  arguments?: { code?: string; brief?: string; [k: string]: unknown }
  output?: string
  [k: string]: unknown
}

/** user.input 的 agent_input —— 控制面（模型 / 思考强度 / 权限）。 */
export interface AgentInput {
  text: string
  files: unknown[]
  refs: unknown[]
  expect_model: string
  reasoning_effort: string
  current_mode: string
  permission_mode: string
  browser_plugin_enabled: boolean
  file_ids: unknown[]
  upload_ids: unknown[]
}

/** 构造 agent_input（默认值 = 实测可用的组合）。 */
export function buildAgentInput(
  text: string,
  opts: { expectModel?: string; reasoningEffort?: string; currentMode?: string; permissionMode?: string } = {},
): AgentInput {
  return {
    text,
    files: [],
    refs: [],
    expect_model: opts.expectModel !== undefined && opts.expectModel !== '' ? opts.expectModel : 'qwen3.8_flash',
    reasoning_effort:
      opts.reasoningEffort !== undefined && opts.reasoningEffort !== '' ? opts.reasoningEffort : 'low',
    current_mode: opts.currentMode !== undefined && opts.currentMode !== '' ? opts.currentMode : 'agent',
    permission_mode:
      opts.permissionMode !== undefined && opts.permissionMode !== '' ? opts.permissionMode : 'default',
    browser_plugin_enabled: false,
    file_ids: [],
    upload_ids: [],
  }
}

/** 构造 user.input 帧。 */
export function buildUserInput(agentInput: AgentInput): CoworkFrame {
  return {
    event: 'user.input',
    data: {
      agent_input: agentInput as unknown as Record<string, unknown>,
      headers: { client_type: 'pc_web', open_position: 'copilotchat_web' },
    },
  }
}

/** 连接 cowork WebSocket。 */
export function connectCowork(sid: string, sessionId: string): WebSocket {
  const url = `${COWORK_BASE.replace('https://', 'wss://')}/api/aioffice/v1/cowork/sessions/${encodeURIComponent(sessionId)}/sandbox/completions/ws`
  // Node 的全局 WebSocket（undici）支持第二参数传握手头。
  return new WebSocket(url, { headers: coworkWsHeaders(sid) } as unknown as string[])
}

// ---------------------------------------------------------------------------
// 沙箱文件（真机实测 2026-10）
//
// 灵犀 agent 的 c_execute_code 跑在**云端沙箱**里，产出的文件默认留在 /home/lingxi/workspace/。
// 用户要「文件保存到我的电脑」，就得把沙箱文件拉回本机 —— 这条路是通的：
//
//   1) 列目录  GET  /api/aioffice/v1/sandbox/sessions/{sessionId}/files?path=<绝对路径>
//              → {"data":{"items":[{name,size,type,key,files?}]}}（目录项把子项放在 items[].files）
//   2) 取直链  POST /api/aioffice/v1/sandbox/file/preview   {key, session_id}
//              → {"data":{"url":"https://...oss...?Signature=...","ext":".txt"}}
//              这个 url 是**预签名 OSS 直链**，不带 cookie 也能下（短期有效）。
//   3) 下载    GET  <url>   → 原始字节
//
// 注意：沙箱里 agent 只有**显式被告知路径**才会落盘（实测不给路径它就只在回答里贴代码），
// 所以供应商要在 prompt 里约定一个产出目录 —— 见 sandbox-artifacts.ts。
// ---------------------------------------------------------------------------

/** 沙箱会话内文件列表端点。 */
export function sandboxFilesUrl(sessionId: string, path: string): string {
  return `${COWORK_BASE}/api/aioffice/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`
}

/** 沙箱文件取直链端点。 */
export const SANDBOX_PREVIEW_URL = `${COWORK_BASE}/api/aioffice/v1/sandbox/file/preview`

/** 沙箱文件项。 */
export interface SandboxFileItem {
  name: string
  size: number
  type: string
  /** 沙箱内绝对路径，用于取直链。 */
  key: string
  /** 目录项的子文件（服务端把子项嵌在父项里）。 */
  files?: SandboxFileItem[]
  [k: string]: unknown
}

/** 列沙箱目录（列不到返回空数组，不抛 —— 拉文件是尽力而为的附加能力）。 */
export async function listSandboxFiles(
  sid: string,
  sessionId: string,
  path: string,
  timeoutMs = 20000,
): Promise<SandboxFileItem[]> {
  try {
    const resp = await fetch(sandboxFilesUrl(sessionId, path), {
      headers: { ...coworkHeaders(sid), Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) return []
    const json = (await resp.json()) as { data?: { items?: SandboxFileItem[] } }
    const items = json.data?.items ?? []
    // 目录项把子文件放在 .files；同时把一层目录展开，方便调用方直接拿到文件。
    const out: SandboxFileItem[] = []
    for (const item of items) {
      if (Array.isArray(item.files)) out.push(...item.files)
      else out.push(item)
    }
    return out
  } catch {
    return []
  }
}

/** 取沙箱文件的预签名下载直链（失败返回 undefined）。 */
export async function getSandboxFileUrl(
  sid: string,
  sessionId: string,
  key: string,
  timeoutMs = 20000,
): Promise<string | undefined> {
  try {
    const resp = await fetch(SANDBOX_PREVIEW_URL, {
      method: 'POST',
      headers: coworkHeaders(sid),
      body: JSON.stringify({ key, session_id: sessionId }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) return undefined
    const json = (await resp.json()) as { data?: { url?: string } }
    const url = json.data?.url
    return url !== undefined && url !== '' ? url : undefined
  } catch {
    return undefined
  }
}

/** 下载沙箱文件内容（失败返回 undefined）。返回 Uint8Array 以支持二进制。 */
export async function downloadSandboxFile(url: string, timeoutMs = 60000): Promise<Uint8Array | undefined> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return undefined
    return new Uint8Array(await resp.arrayBuffer())
  } catch {
    return undefined
  }
}

/** 解析一帧文本；不是合法 JSON 时返回 undefined。 */
export function parseFrame(raw: string): CoworkFrame | undefined {
  try {
    const j = JSON.parse(raw) as CoworkFrame
    if (typeof j.event !== 'string') return undefined
    return j
  } catch {
    return undefined
  }
}
