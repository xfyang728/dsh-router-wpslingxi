/**
 * wpslingxi 供应商插件入口 —— 把 WPS 灵犀实现包装成符合契约的 SupplierModule。
 *
 * 作为 dsh-router 的外部供应商：通过 router.suppliers service 把 factory 暴露给
 * dsh-router 加载。通用能力（连接池/模型管理/别名/凭证）由 dsh-router 核心统一管
 * （env 注入），这里只暴露差异化方法。
 */
import { WpslingxiSupplier, SUPPLIER_ID, SUPPLIER_NAME } from './supplier.ts'
import type { ChatOnceResult, SupplierEnv, SupplierModule, SupplierStatusNow } from '../contract.ts'
import type { ModelInfo, ChatRequest } from '../types.ts'

export const id = SUPPLIER_ID
export const name = SUPPLIER_NAME
export const priority = 20
/** 面板图标（WPS 灵犀：SVG data URI，简洁「灵」字形圆角块）。 */
export const icon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#d93a3a"/><text x="16" y="22" font-family="sans-serif" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">灵</text></svg>`,
  )

/** 「添加 API key」弹窗提示：让用户去 lingxi.wps.cn DevTools 复制 wps_sid cookie。 */
export const apiKeyHint =
  '填入 wps_sid cookie 值：登录 lingxi.wps.cn 后，浏览器 DevTools → Application → Cookies → 复制 wps_sid 的值。'

let instance: WpslingxiSupplier | undefined

/** factory：dsh-router 调用它构造实例（env 注入 store/credentials）。 */
export default function factory(env: SupplierEnv): SupplierModule & { removeLink?(uid: string): Promise<boolean> } {
  // env 整个传进去：插件在**调用时**才读 env.onLateFailure（核心是先跑 factory
  // 再挂这个回调的，构造时读必是 undefined）。
  instance = new WpslingxiSupplier(env)
  return {
    id,
    name,
    priority,
    icon,
    apiKeyHint,
    status: (): SupplierStatusNow => instance!.status(),
    listModels: (force?: boolean): ModelInfo[] | Promise<ModelInfo[]> => instance!.listModels(force),
    chatOnce: (uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> => instance!.chatOnce(uid, lv, req),
    dispose: (): void => instance!.dispose(),
    addApiKey: (input: { name: string; apiKey: string }) => instance!.addApiKey(input),
    removeLink: (uid: string): Promise<boolean> => instance!.removeLink(uid),
  }
}
