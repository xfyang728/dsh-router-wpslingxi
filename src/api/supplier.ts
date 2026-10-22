/**
 * WpslingxiSupplier —— 供应商实现主体（chat plans via wps_sid cookie）。
 */
import type { AccountState, ChatOnceResult, SupplierEnv, SupplierStatusNow } from '../contract.ts'
import type { ChatRequest, ModelInfo } from '../types.ts'
import {
  BASE,
  buildExpertBody,
  createSession,
  fetchCredits,
  fetchIdentity,
  fetchPlans,
  postExpertCompletion,
  stateFromHttpStatus,
  type CreditsResponse,
  type PlansResponse,
} from './index.ts'
import { openAiChunk, openAiFinal } from './stream.ts'
import {
  buildAgentInput,
  buildUserInput,
  connectCowork,
  createCoworkSession,
  parseFrame,
  type CoworkFrame,
} from './cowork.ts'
import {
  frameCredit,
  frameError,
  frameToDeltas,
  isRunEnd,
  isToolDelta,
  newCoworkState,
  renderToolDelta,
} from './cowork-stream.ts'
import { pullSandboxArtifacts, renderPullSummary, withArtifactInstruction } from './sandbox-artifacts.ts'

/** 凭证 blob（credentials store 里存的就是它）。 */
export interface LingxiAccount {
  name: string
  wpsSid: string
}

export const SUPPLIER_ID = 'wpslingxi'
export const SUPPLIER_NAME = 'WPS 灵犀'

/**
 * WebSocket 连接器 —— 默认真的连 cowork；单测可替换成假实现。
 * （测试注入点，生产代码不要改它。）
 */
export let wsConnector: (sid: string, sessionId: string) => WebSocket = connectCowork

/** 替换 WS 连接器（仅测试用）。传 undefined 还原默认。 */
export function setWsConnector(fn: ((sid: string, sessionId: string) => WebSocket) | undefined): void {
  wsConnector = fn ?? connectCowork
}

/** credits 上报：拿不到报 -1（不是 0）。 */
const CREDITS_UNKNOWN = -1

/** 从 OpenAI message.content 提取纯文本：string 直取；数组拼接 text part；其余 stringify；缺省 ''。 */
function extractText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((p) => (p !== null && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
  }
  if (c === undefined || c === null) return ''
  return JSON.stringify(c)
}

export class WpslingxiSupplier {
  private readonly env: SupplierEnv
  private modelsCache: ModelInfo[] | undefined

  constructor(env: SupplierEnv) {
    this.env = env
  }

  private listKeys(): string[] {
    return this.env.credentials.list(SUPPLIER_ID)
  }

  private getKey(uid: string): LingxiAccount | undefined {
    return this.env.credentials.get<LingxiAccount>(SUPPLIER_ID, uid)
  }

  private ordered(): Array<{ uid: string; acct: LingxiAccount }> {
    const byUid = new Map(this.listKeys().map((uid) => [uid, uid] as const))
    const order = this.env.store.get(SUPPLIER_ID).poolOrder
    const uids = [...order.filter((u) => byUid.has(u)), ...this.listKeys().filter((u) => !order.includes(u))]
    return uids.map((uid) => ({ uid, acct: this.getKey(uid)! })).filter((x) => x.acct !== undefined)
  }

  /**
   * 模型列表。
   *
   * 上报 `data.models` 里的**真实模型 key**（如 deepseek-v4-pro-0813）优先；
   * 若该端点没给 models，则退回 plans（Pro/Max 模式 key）。
   *
   * 注意：专家模式端点（/expert_completion）的 body 里**没有模型字段**，上游按
   * 会话/账号默认路由 —— 这里的列表主要是给用户在面板上选一个可读的名字。
   */
  async listModels(force?: boolean): Promise<ModelInfo[]> {
    if (!force && this.modelsCache !== undefined && this.modelsCache.length > 0) return this.modelsCache
    const acct = this.ordered()[0]
    if (acct === undefined) return this.modelsCache ?? []
    try {
      const resp = await fetchPlans(acct.acct.wpsSid)
      if (!resp.ok) return this.modelsCache ?? []
      const json = (await resp.json()) as PlansResponse
      const real = json.data?.models ?? []
      const source = real.length > 0 ? real : (json.data?.plans ?? [])
      const models: ModelInfo[] = []
      const seen = new Set<string>()
      for (const p of source) {
        if (p.key === '' || seen.has(p.key)) continue
        seen.add(p.key)
        models.push({ id: p.key })
      }
      if (models.length > 0) this.modelsCache = models
      return models
    } catch {
      return this.modelsCache ?? []
    }
  }

  /** status：报账号 + 积分（余额端点 total_balance，失败 -1）。 */
  status(): SupplierStatusNow {
    const accounts = this.ordered().map(({ uid, acct }) => {
      // 探活交给 addApiKey 和 chatOnce；这里只做缓存回读，不阻塞面板
      return { uid, nickname: acct.name, credits: CREDITS_UNKNOWN, state: 'ok' as AccountState }
    })
    return { id: SUPPLIER_ID, name: SUPPLIER_NAME, accounts }
  }

  /** 主动拉一次积分（chatOnce 成功后/面板刷新时用）。 */
  async refreshCredits(uid: string): Promise<number> {
    const acct = this.getKey(uid)
    if (acct === undefined) return CREDITS_UNKNOWN
    try {
      const resp = await fetchCredits(acct.wpsSid)
      if (!resp.ok) return CREDITS_UNKNOWN
      const json = (await resp.json()) as CreditsResponse
      const d = json.data
      if (d === undefined) return CREDITS_UNKNOWN
      // 余额端点没有 total_balance 字段（实测）：余额散在 bonus_credits[].balance 里，
      // 有 total_balance 时优先用它。
      let total = typeof d.total_balance === 'number' ? d.total_balance : 0
      let seen = typeof d.total_balance === 'number'
      for (const entry of d.bonus_credits ?? []) {
        if (typeof entry.balance === 'number') {
          total += entry.balance
          seen = true
        }
      }
      for (const entry of d.purchased_credits ?? []) {
        if (typeof entry.balance === 'number') {
          total += entry.balance
          seen = true
        }
      }
      return seen ? Math.round(total) : CREDITS_UNKNOWN
    } catch {
      return CREDITS_UNKNOWN
    }
  }

  /** 剥 alias 前缀（wl/xxx → xxx）。 */
  private stripAlias(model: string): string {
    const alias = this.env.store.get(SUPPLIER_ID).alias || SUPPLIER_ID
    return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
  }

  async addApiKey(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> {
    const sid = input.apiKey.trim()
    if (sid === '') return { ok: false, error: 'wps_sid 不能为空' }
    // 验证：identity 端点，无效 sid 401
    try {
      const probe = await fetchIdentity(sid)
      if (!probe.ok) {
        const text = await probe.text().catch(() => '')
        return { ok: false, error: `wps_sid 无效: ${probe.status} ${text.slice(0, 200)}` }
      }
    } catch (err) {
      return { ok: false, error: `验证失败: ${(err as Error).message}` }
    }
    let n = this.listKeys().length + 1
    let uid = `sid-${n}`
    while (this.getKey(uid) !== undefined) uid = `sid-${++n}`
    const nickname = input.name.trim() || `灵犀 ${n}`
    this.env.credentials.save(SUPPLIER_ID, uid, { name: nickname, wpsSid: sid } satisfies LingxiAccount)
    this.env.log(`wpslingxi add account ${uid}`)
    return { ok: true, account: { uid, nickname } }
  }

  async removeLink(uid: string): Promise<boolean> {
    if (this.getKey(uid) === undefined) return false
    this.env.credentials.remove(SUPPLIER_ID, uid)
    return true
  }

  async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
    const acct = this.getKey(uid)
    if (acct === undefined) {
      return { ok: false, state: 'no_such_model', message: `unknown account ${JSON.stringify(uid)}` }
    }
    const sid = acct.wpsSid
    const model = this.stripAlias(req.model)

    // 模型校验：不在列表 → no_such_model（核心跳过本供应商，不惩罚账号）
    const models = await this.listModels(false)
    if (models.length > 0 && !models.some((m) => m.id === model)) {
      return { ok: false, state: 'no_such_model', message: `unknown model ${JSON.stringify(req.model)}` }
    }

    // 1) 解析 OpenAI 请求体 → 取最后一条 user 消息文本
    let userText: string
    try {
      const obj = JSON.parse(req.rawBody) as { messages?: Array<{ role?: string; content?: unknown }> }
      const msgs = obj.messages ?? []
      const last = [...msgs].reverse().find((m) => m.role === 'user')
      const c = last?.content
      userText = extractText(c)
    } catch {
      return { ok: false, state: 'bad_request', message: 'cannot parse request body' }
    }
    if (userText === '') {
      return { ok: false, state: 'bad_request', message: 'empty user message' }
    }

    // 2) 建 **cowork** 会话（与 aigc 的会话端点不同，host 也不同：lingxi.kdocs.cn）。
    //    只有 cowork 通道会推 c_reasoning（思考）和 c_execute_code（真沙箱执行）。
    let sessionId: string
    try {
      const created = await createCoworkSession(sid)
      if (!created.ok) {
        const state = stateFromHttpStatus(created.status)
        return { ok: false, state, message: `create cowork session ${created.status}: ${created.body}` }
      }
      sessionId = created.sessionId
    } catch (err) {
      return { ok: false, state: 'transport', message: `create cowork session: ${(err as Error).message}` }
    }
    // 3) 连 cowork WebSocket 并推一轮。
    //    控制面在 user.input.agent_input：expect_model 选真模型、reasoning_effort 定思考强度、
    //    permission_mode 管工具权限。
    const modelKey = model === '' ? undefined : model
    // 追加「产出目录」约定：不给路径 Agent 不会落盘（实测），给了才会真写到沙箱。
    const agentInput = buildAgentInput(withArtifactInstruction(userText), {
      ...(modelKey !== undefined ? { expectModel: modelKey } : {}),
    })

    const onLateFailure = this.env.onLateFailure
    // **坑**：stream 回调里的 `this` 是 underlying source，不是本实例 —— 一律用闭包捕获。
    const log = this.env.log
    let closed = false
    const encoder = new TextEncoder()
    /**
     * 收尾：把沙箱产出目录里的文件拉回**会话工作目录**，补一段回传摘要，
     * 再补 finish_reason=stop 的 chunk 并关闭控制器（只允许生效一次）。
     *
     * 为什么在这里拉：`c_execute_code` 跑在云端沙箱，文件不会自己出现在用户机器上；
     * 供应商跑在 DSH 宿主进程（= 用户的机器），所以能顺手回传。拉取是**尽力而为**的：
     * 任何一步失败都只记日志，绝不影响已经把正文交给用户的那一轮回答。
     */
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      if (closed) return
      closed = true
      const closeNow = (): void => {
        try {
          controller.enqueue(encoder.encode(openAiFinal('chatcmpl-lingxi', model)))
          controller.close()
        } catch {
          // 控制器已被取消：忽略（读侧已断）
        }
      }
      void (async () => {
        try {
          const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : ''
          if (cwd !== '') {
            const pulled = await pullSandboxArtifacts(sid, sessionId, cwd, log)
            if (pulled.seen > 0) {
              log(`wpslingxi artifacts seen=${pulled.seen} saved=${pulled.saved.length} failed=${pulled.failed.length} -> ${cwd}`)
              const summary = renderPullSummary(pulled, cwd)
              if (summary !== '') {
                controller.enqueue(encoder.encode(openAiChunk('chatcmpl-lingxi', model, { content: summary })))
              }
            }
          }
        } catch (err) {
          log(`wpslingxi artifact pull failed: ${(err as Error).message}`)
        }
        closeNow()
      })()
    }

    let ws: WebSocket
    try {
      ws = wsConnector(sid, sessionId)
    } catch (err) {
      return { ok: false, state: 'transport', message: `cowork ws connect: ${(err as Error).message}` }
    }

    // **坑**：ReadableStream 的 underlying-source 对象字面量里，回调的 `this` 指向 source
    // 本身而不是本实例 —— 回调里一律用闭包变量（真机踩过：this.env 为 undefined 让第一次
    // pull 抛 TypeError，消费者永久等不到 done）。
    const state = newCoworkState()
    /** 把一帧推给 client。`done` = 本轮已结束；`produced` = 真正写出了字节。 */
    const pushFrame = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      frame: CoworkFrame,
    ): { done: boolean; produced: boolean } => {
      const errMsg = frameError(frame)
      if (errMsg !== undefined) {
        onLateFailure?.(uid, model, 'unknown', errMsg)
        return { done: false, produced: false }
      }
      let produced = false
      for (const delta of frameToDeltas(frame, state)) {
        if (isToolDelta(delta)) {
          controller.enqueue(encoder.encode(openAiChunk('chatcmpl-lingxi', model, { content: renderToolDelta(delta) })))
          produced = true
        } else if (delta.text !== '') {
          controller.enqueue(
            encoder.encode(
              openAiChunk('chatcmpl-lingxi', model, delta.kind === 'reasoning' ? { reasoning_content: delta.text } : { content: delta.text }),
            ),
          )
          produced = true
        }
      }
      if (isRunEnd(frame)) {
        const credit = frameCredit(frame)
        if (credit !== undefined) log(`wpslingxi run.end credits=${credit} model=${model}`)
        return { done: true, produced }
      }
      return { done: false, produced }
    }

    // 帧先落到队列，pull 负责消费 —— WS 是推模型，readable 是拉模型，中间必须有缓冲。
    const queue: CoworkFrame[] = []
    let wsDone = false
    let waiter: (() => void) | undefined
    const wake = (): void => {
      const w = waiter
      waiter = undefined
      w?.()
    }

    ws.addEventListener('message', (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      if (raw === '') return
      const frame = parseFrame(raw)
      if (frame === undefined) return
      queue.push(frame)
      wake()
    })
    ws.addEventListener('close', () => {
      wsDone = true
      wake()
    })
    ws.addEventListener('error', () => {
      onLateFailure?.(uid, model, 'transport', 'cowork websocket error')
      wsDone = true
      wake()
    })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: 'chatcmpl-lingxi', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
          ),
        )
        const send = (): void => {
          if (ws.readyState !== 1) return
          try {
            ws.send(JSON.stringify(buildUserInput(agentInput)))
          } catch (err) {
            onLateFailure?.(uid, model, 'transport', `cowork ws send: ${(err as Error).message}`)
          }
        }
        // 连接可能还在 CONNECTING，等 open 再发。
        if (ws.readyState === 1) send()
        else ws.addEventListener('open', send, { once: true })
      },
      async pull(controller) {
        // **必须循环到「产出数据」或「收尾」才能返回。**
        //
        // 这是本文件最贵的一个坑（真机 + 单测各踩一次）：ReadableStream 只在**上一次 pull
        // 解决、且队列空**时才再次调用 pull。若 pull 处理完一帧却什么都没 enqueue 就返回
        // （例如只碰到 run.start / component.start / c_recommend 这种无正文的帧），读侧的
        // read() 会永远挂着 —— 因为不会有人再触发下一次 pull。表现为「只拿到第一条 role
        // delta 后永久卡死」。
        for (;;) {
          if (closed) return
          let produced = false
          while (queue.length > 0) {
            const frame = queue.shift()!
            const res = pushFrame(controller, frame)
            if (res.done) {
              try {
                ws.close()
              } catch {
                // 已关闭
              }
              finish(controller)
              return
            }
            if (res.produced) {
              produced = true
              return
            }
            // 本帧无产出：继续消费队列，绝不空手返回。
          }
          if (wsDone) {
            finish(controller)
            return
          }
          // 队列空了：等下一帧（不 busy-loop）。
          await new Promise<void>((resolve) => {
            waiter = resolve
          })
        }
      },
      cancel() {
        try {
          ws.close()
        } catch {
          // 已关闭
        }
        closed = true
      },
    })
    return { ok: true, stream }
  }

  dispose(): void {
    this.modelsCache = undefined
  }
}