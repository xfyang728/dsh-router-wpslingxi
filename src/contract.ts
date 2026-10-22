/**
 * 供应商契约 —— dsh-router-wpslingxi 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 suppliers/contract.ts 契约保持同步：
 * 通用能力（连接池/模型管理/别名/凭证）由 dsh-router 核心统一管，
 * 本插件只提供**差异化能力**。
 */
import type { ChatRequest, ModelInfo } from './types.ts'

/** 通用配置存储（dsh-router 核心注入；连接池/模型管理/别名/积分缓存）。 */
export interface SupplierConfigStoreLike {
  get(id: string): {
    alias: string
    disabled: string[]
    custom: string[]
    poolOrder: string[]
    poolStrategy: 'fallback' | 'round-robin'
    /** 积分缓存：uid → 剩余额度（-1 = 还没拿到过）。 */
    credits: Record<string, number>
  }
  setAlias(id: string, alias: string): void
  setPoolOrder(id: string, uids: string[]): void
  setPoolStrategy(id: string, strategy: string): void
  setModelEnabled(id: string, modelId: string, enabled: boolean): void
  addCustomModel(id: string, modelId: string): void
  removeCustomModel(id: string, modelId: string): void
  setAllModelsEnabled(id: string, enabled: boolean, modelIds: string[]): void
  /** 读积分缓存；没缓存过返回 -1。 */
  getCredits(id: string, uid: string): number
  /** 合并插件报的积分：-1（未知）回落到缓存值，非 -1 写入并返回它。 */
  putCredits(id: string, uid: string, reported: number): number
  /** 删链接时清掉它的积分缓存。 */
  clearCredits(id: string, uid: string): void
}

/** 通用凭证存储（dsh-router 核心注入；不透明凭证 blob）。 */
export interface CredentialStoreLike {
  list(supplierId: string): string[]
  get<T = unknown>(supplierId: string, uid: string): T | undefined
  save(supplierId: string, uid: string, blob: unknown): void
  remove(supplierId: string, uid: string): void
}

/**
 * 核心注入的运行时环境中，本插件真正用到的部分。
 *
 * `onLateFailure` 是迟到失败上报（流式响应已提交后才发现的错误）。核心是
 * **先跑 factory 再挂这个回调**的，所以插件必须在**调用时**读它，不能在
 * 构造函数里缓存 —— 构造时读必是 undefined。
 */
export interface SupplierEnvLike {
  /** 核心注入的**绝对**数据目录。 */
  dataDir?: string
  onLateFailure?: (uid: string, model: string, state: AccountState, message: string) => void
}

/**
 * 账户此刻的状态 —— 插件**解读**上游信号后的语义状态。
 * 插件只报「现在怎么了」，不说「该怎么办」：冷却多久、是否禁用、要不要换号
 * 都是核心的策略。
 */
export type AccountState =
  | 'ok'            // 正常
  | 'rate_limit'    // 限流（429 类）
  | 'quota'         // 额度/权益不足
  | 'session_dead'  // 凭证彻底失效，必须重新登录才能恢复
  | 'unavailable'   // 上游不可用（404 / 服务下线）
  | 'transport'     // 网络/连接层失败（没拿到 HTTP 状态）
  | 'unknown'       // 说不清是什么错
  /** 这个模型不属于本供应商（不是账号的失败）。核心据此跳过整个供应商换下一个。 */
  | 'no_such_model'
  /** 请求本身不合法，被上游拒。核心据此不惩罚账号，直接跳出本供应商。 */
  | 'bad_request'

/** 账号「现在状态」（插件只报它观察到的部分）。 */
export interface SupplierAccountNow {
  uid: string
  nickname?: string
  /**
   * 剩余额度。**拿不到就报 `-1`**，不是 0：
   * 插件刚重启、积分拉取失败、或压根不支持积分时都是 `-1`。
   */
  credits: number
  state: AccountState
  message?: string
}

/** 插件报的供应商状态。 */
export interface SupplierStatusNow {
  id: string
  name: string
  accounts: SupplierAccountNow[]
}

/** 一次上游调用的结果。 */
export type ChatOnceResult =
  /** 流式：插件已把上游协议转成 OpenAI SSE，核心只负责 pipe 到 res。 */
  | { ok: true; stream: ReadableStream<Uint8Array> }
  /** 非流式：核心写 JSON。 */
  | { ok: true; status: number; body: string }
  /** 失败：核心据此做冷却/禁用/换号。 */
  | { ok: false; state: AccountState; message: string }

/** 供应商配置：dsh-router 核心注入的运行时环境。 */
export interface SupplierEnv {
  /** 数据目录（state.json / keys.json 所在目录）。 */
  dataDir: string
  /** 日志。 */
  log: (msg: string) => void
  /** 通用配置存储。 */
  store: SupplierConfigStoreLike
  /** 通用凭证存储。 */
  credentials: CredentialStoreLike
  /** 迟到的失败上报（可选）——**只在响应已提交之后**才用。调用时读，别构造时缓存。 */
  onLateFailure?: (uid: string, model: string, state: AccountState, message: string) => void
}

/** 供应商模块 —— 契约（核心必须，差异化可选）。 */
export interface SupplierModule {
  readonly id: string
  readonly name: string
  readonly priority?: number
  /** 图标（URL 或 SVG data URI），面板供应商卡片显示。可选。 */
  readonly icon?: string
  /** 「添加 API key」弹窗的提示文案。可选。 */
  readonly apiKeyHint?: string

  // ---- 核心（必须） ----
  status(): SupplierStatusNow
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult>
  dispose(): void

  // ---- 差异化能力（可选） ----
  /** 添加 API key 账号（这里 = 粘贴 wps_sid cookie 值）。有它显示连接池。 */
  addApiKey?(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }>
  /** 删除链接（清理凭证）。 */
  removeLink?(uid: string): Promise<boolean>
}
