/**
 * 灵犀云 API 封装 —— lingxi.wps.cn，鉴权 = Cookie wps_sid=<值>。
 *
 * 协议（2026-10 真机实测确认）：
 *
 *   1) 建会话
 *      POST /api/aigc/v3/assistant/sessions
 *      body {"session_type":"chat","session_mode":"expert"}
 *      → 200 {"data":{"session_id":"11971827723468828"},"result":"ok"}
 *
 *   2) 发消息 —— **必须走专家模式端点**（界面上的「专家模式」开关 = 这里）
 *
 *      POST /api/aigc/v3/assistant/sessions/{session_id}/expert_completion
 *      body { question, files: [], enable_render_image: true }
 *
 *      **注意端点名是单数 expert_completion**，且 body 极简：只有 question
 *      （+ files / enable_render_image / 可选 context）。这是灵犀桌面端
 *      agent3 通道用的形状（basePath "/solution/api/aigc/v3/assistant/sessions"）。
 *
 *      对照：老的 /completions 端点（body 带 text/thinking/expect_model/…）
 *      仍可用，但**只会回一段短直答**且永远不产出思考帧 —— 界面上的
 *      「专家模式」开关真正切的是 expert_completion 这条通道。
 *
 *      → 200 text/event-stream，帧形如  event:<name>\n data:<json>\n\n
 *        事件名（event 行）才是语义类型（data 里没有 type 字段）：
 *          execution          → { data:{user_request:{content}}, type:"user" } 回声
 *          run.start          → { run_id }
 *          turn.start         → { turn_id, agent_id, location_type }
 *          component.start    → { component_id, component_type }（如 TEXT_BLOCK）
 *          component.content  → { component_id, delta }   ← **正文增量**
 *          component.end      → { component_id, full_content, component_type }
 *          turn.end           → { turn_id, agent_id, agent_time }
 *          run.end            → { run_id }
 *          finish             → 空 data，流终止
 *          :keepalive         → SSE 注释行，忽略
 *        注意流里混着 `:keepalive` 注释行，分帧时不要当成事件。
 *
 *   3) 模型/套餐
 *      GET /api/aioffice/v1/sessions/plans
 *      → {data:{plans:[{key:"plan_pro"|"plan_max",name,max_context_tokens,...}],
 *               models:[{key:"deepseek-v4-flash-0731",...}]}}
 *      plans 是「模式」（expect_model 用它），models 是具体模型档位。
 *
 *   4) 积分
 *      GET /api/public/v1/credits/balance?credit_type=total
 *      → {data:{enabled,bonus_credits:[{balance,value,expire_time}],...}}
 */

/** 云 API 基址。 */
export const BASE = 'https://lingxi.wps.cn'

const AIGC = `${BASE}/api/aigc/v3/assistant`

/** 会话端点（建会话 / 发消息共用前缀）。 */
export const SESSIONS_URL = `${AIGC}/sessions`

/** 套餐+模型端点。 */
export const PLANS_URL = `${BASE}/api/aioffice/v1/sessions/plans`

/** 积分余额端点。 */
export const CREDITS_URL = `${BASE}/api/public/v1/credits/balance`

/** 桌面端自报的客户端标识（app-server 4.27.0 / lingxi 1.3.17）。 */
export const CLIENT_TYPE = 'lingxi-desktop'
export const CC_VERSION = '1'
export const CC_ENTRANCE = 'web'

/** 通用请求头（带 wps_sid cookie）。 */
export function baseHeaders(sid: string): Record<string, string> {
  return {
    Cookie: `wps_sid=${sid}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 lingxi/1.3.17',
    Accept: '*/*',
  }
}

/** 建会话/发消息用的完整头（桌面端 cc 头）。 */
export function ccHeaders(sid: string): Record<string, string> {
  return {
    ...baseHeaders(sid),
    'Content-Type': 'application/json',
    'X-Cc-Version': CC_VERSION,
    'X-Client-Type': CLIENT_TYPE,
    'X-Cc-Entrance': CC_ENTRANCE,
  }
}

/** 用户身份探测（addApiKey 验证用）。 */
export async function fetchIdentity(sid: string, timeoutMs = 15000): Promise<Response> {
  return fetch(`${AIGC}/identity`, {
    headers: baseHeaders(sid),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** plans+models 原始响应形状。 */
export interface PlanEntry {
  key: string
  name?: string
  desc?: string
  multiplier?: string | number
  max_context_tokens?: number
  max_input_tokens?: number
  max_new_tokens?: number
  reasoning_efforts?: string[]
}

export interface PlansResponse {
  data?: { plans?: PlanEntry[]; models?: PlanEntry[] }
}

/** 拉套餐/模型列表。 */
export async function fetchPlans(sid: string, timeoutMs = 15000): Promise<Response> {
  return fetch(PLANS_URL, {
    headers: baseHeaders(sid),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** 拉积分余额。 */
export async function fetchCredits(sid: string, creditType = 'total', timeoutMs = 15000): Promise<Response> {
  const url = `${CREDITS_URL}?credit_type=${encodeURIComponent(creditType)}`
  return fetch(url, {
    headers: baseHeaders(sid),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export interface CreditsResponse {
  data?: {
    enabled?: boolean
    total_balance?: number
    total_contract?: number
    bonus_credits?: Array<{ balance?: number; value?: number; expire_time?: string }>
    purchased_credits?: Array<{ balance?: number; value?: number }>
  }
}

/** 建 chat 会话，返回会话 id。
 *
 *  **expert** = 界面上的「专家模式」，思考能力的前提：建会话不带
 *  session_mode:"expert" 时，后续 completions 即使 thinking:"on" 也只回直答。 */
export async function createSession(
  sid: string,
  expert = true,
  timeoutMs = 30000,
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; body: string }> {
  let resp: Response
  try {
    resp = await fetch(SESSIONS_URL, {
      method: 'POST',
      headers: ccHeaders(sid),
      body: JSON.stringify(expert ? { session_type: 'chat', session_mode: 'expert' } : { session_type: 'chat' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message }
  }
  const text = await resp.text().catch(() => '')
  if (!resp.ok) return { ok: false, status: resp.status, body: text.slice(0, 300) }
  try {
    const json = JSON.parse(text) as { data?: { session_id?: string; id?: string } }
    const id = json.data?.session_id ?? json.data?.id
    if (id === undefined || id === '') {
      return { ok: false, status: resp.status, body: `no session_id: ${text.slice(0, 300)}` }
    }
    return { ok: true, sessionId: id }
  } catch {
    return { ok: false, status: resp.status, body: `bad json: ${text.slice(0, 300)}` }
  }
}

/**
 * completions 请求体（灵犀自有形状）。
 *
 * **不是** OpenAI 的 `{messages:[...]}`：body 是扁平的，正文放 `question`
 * （同时保留 `text`，桌面端两者都发 —— 实测两个字段都需要，缺 question
 * 会被上游判 InvalidArgument）。`expect_model` 收 plan key（plan_pro /
 * plan_max / 具体模型 key），上游会把 `plan_` 前缀剥掉再路由。
 */
/** 「思考/专家模式」开关取值（字符串枚举，布尔值会被上游拒绝）。 */
export type ThinkingMode = 'on' | 'off' | 'auto'

export interface CompletionsBody {
  text: string
  question: string
  file_ids: unknown[]
  upload_ids: unknown[]
  /** 思考开关：**字符串**，布尔会 InvalidArgument。 */
  thinking: ThinkingMode
  expect_model?: string
  /** 思考强度（如 "high"/"medium"/"low"），与 thinking 独立。 */
  reasoning_effort?: string
  quote_files: unknown[]
  quote_images: unknown[]
}

export function buildCompletionsBody(
  text: string,
  expectModel?: string,
  effort?: string,
  thinking: ThinkingMode = 'on',
): CompletionsBody {
  const body: CompletionsBody = {
    text,
    question: text,
    file_ids: [],
    upload_ids: [],
    thinking,
    quote_files: [],
    quote_images: [],
  }
  if (expectModel !== undefined && expectModel !== '') body.expect_model = expectModel
  if (effort !== undefined && effort !== '') body.reasoning_effort = effort
  return body
}

/** 发 completions（旧直答通道），返回 SSE Response。 */
export async function postCompletions(
  sid: string,
  sessionId: string,
  body: CompletionsBody,
  timeoutMs = 300000,
): Promise<Response> {
  return fetch(`${SESSIONS_URL}/${encodeURIComponent(sessionId)}/completions`, {
    method: 'POST',
    headers: { ...ccHeaders(sid), Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * 专家模式请求体（灵犀桌面端 agent3 通道形状）。
 *
 * 极简：只要 question；files/enable_render_image 是客户端固定值。
 */
export interface ExpertBody {
  question: string
  files: unknown[]
  enable_render_image: boolean
}

export function buildExpertBody(question: string): ExpertBody {
  return { question, files: [], enable_render_image: true }
}

/**
 * 发专家模式消息（**界面上的「专家模式」开关走的就是这条**）。
 *
 * 端点名是单数 `expert_completion`。返回 SSE Response，调用方消费 body 流。
 */
export async function postExpertCompletion(
  sid: string,
  sessionId: string,
  body: ExpertBody,
  timeoutMs = 600000,
): Promise<Response> {
  return fetch(`${SESSIONS_URL}/${encodeURIComponent(sessionId)}/expert_completion`, {
    method: 'POST',
    headers: { ...ccHeaders(sid), Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** 上游 HTTP 状态 → 账号语义状态。 */
export function stateFromHttpStatus(
  status: number,
): 'rate_limit' | 'quota' | 'session_dead' | 'unavailable' | 'transport' | 'unknown' {
  if (status === 0) return 'transport'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 429) return 'rate_limit'
  if (status === 402) return 'quota'
  if (status === 404) return 'unavailable'
  return 'unknown'
}
