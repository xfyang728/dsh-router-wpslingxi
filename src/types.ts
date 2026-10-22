/**
 * 类型定义 —— dsh-router-wpslingxi 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 router/types.ts 契约保持同步。
 */
import type { AccountState, ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from './contract.ts'

export type { AccountState, ChatOnceResult, SupplierAccountNow, SupplierStatusNow }

/** OpenAI 模型条目。 */
export interface ModelInfo {
  id: string
  context_length?: number
}

/** 一次 /v1/chat/completions 请求。 */
export interface ChatRequest {
  /** 原始请求体 JSON 字符串。 */
  rawBody: string
  stream: boolean
  model: string
}
