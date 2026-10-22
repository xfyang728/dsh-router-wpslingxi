/**
 * 沙箱产出文件回传本机（真机实测 2026-10）。
 *
 * ## 为什么需要它
 *
 * 灵犀的 `c_execute_code` 跑在**云端沙箱**（Go 服务，/home/lingxi/workspace），
 * 文件不会自动出现在用户电脑上。用户看到的「脚本已保存：quicksort.py」指向
 * `/home/lingxi/workspace/quicksort/quicksort.py` —— 那是沙箱内的路径，本机没有。
 *
 * 供应商跑在 DSH 宿主进程里（= 用户的机器），所以能把这层补上：
 *
 *   1) 发问前，往 prompt 里追加一段「产出目录」约定，让 agent 把文件写到已知目录；
 *   2) 本轮 run.end 之后，列该目录 → 取预签名直链 → 下载 → 落到**会话工作目录**。
 *
 * ## 实测行为（很重要）
 *
 * - **不给路径，agent 不会落盘**：prompt 只说「脚本要保存成文件方便我拿走」，沙箱里
 *   `/home/lingxi/workspace/output`、`/home/lingxi/workspace`、`/tmp` 全空 —— 它只在
 *   回答里贴代码。所以必须显式约定路径。
 * - 给了路径就真落盘：`/home/lingxi/workspace/output/quicksort.py` 实测 2180 字节，
 *   并能在 agent 自己的 `ls` 输出里看到。
 * - 沙箱根目录下已有 `.rundata` 和 `output` 两个目录，所以用 `output` 最自然。
 * - 上传方向（本机 → 沙箱）也可用：`POST /api/aioffice/v1/cowork/sessions/{id}/files`
 *   （multipart `path` + `file`），但落地在 `/home/lingxi/workspace/.lxenc/<base64>`，
 *   **对 agent 是隐形的**，所以本模块不做上传，只做「产出回传」。
 */

import { downloadSandboxFile, getSandboxFileUrl, listSandboxFiles, type SandboxFileItem } from './cowork.ts'

/** agent 的产出目录（沙箱内绝对路径；沙箱根下已有 output/，用它最自然）。 */
export const SANDBOX_OUTPUT_DIR = '/home/lingxi/workspace/output'

/** 追加到用户消息末尾的产出目录约定。 */
export const ARTIFACT_INSTRUCTION = `\n\n---\n[系统约定] 如果你在回答中生成了任何文件（脚本、代码、文档、数据），请把文件**实际写入**目录 \`${SANDBOX_OUTPUT_DIR}\`（用文字写文件或运行代码都可以），文件名要有意义。只把代码贴在回答里、不落盘是不合格的。若本次不需要生成文件，请忽略本约定。`

/** 把用户的原始提问包成带产出目录约定的版本。 */
export function withArtifactInstruction(userText: string): string {
  // 已经在提这个话题（例如插件重试、用户自己写了路径）就不要重复追加。
  if (userText.includes(SANDBOX_OUTPUT_DIR)) return userText
  return userText + ARTIFACT_INSTRUCTION
}

/** 一个待回传的文件。 */
export interface PulledFile {
  /** 沙箱内路径。 */
  key: string
  /** 文件名。 */
  name: string
  /** 字节数。 */
  size: number
}

/** 拉取结果：落到磁盘的文件 + 失败清单（失败不抛，拉文件是附加能力）。 */
export interface PullResult {
  saved: PulledFile[]
  failed: string[]
  /** 沙箱里看到的文件总数（用于区分「没有文件」和「有文件但下不来」）。 */
  seen: number
}

/**
 * 把沙箱产出目录里的文件拉到本机目录。
 *
 * @param sid      wps_sid
 * @param sessionId cowork 会话 id
 * @param destDir  本机目标目录（通常是会话工作目录）
 * @param log      日志
 */
export async function pullSandboxArtifacts(
  sid: string,
  sessionId: string,
  destDir: string,
  log: (msg: string) => void,
): Promise<PullResult> {
  const items = await listSandboxFiles(sid, sessionId, SANDBOX_OUTPUT_DIR)
  // 只取真正的文件（有 key、有名字、不是目录）。
  // 名字里带路径分隔符的**不丢弃而是取 basename** —— 沙箱返回的名字不该有，但真出现了也
  // 不能让它写出目标目录（落盘前还有第二道 basename 处理）。
  const files: SandboxFileItem[] = items.filter(
    (f) => typeof f.key === 'string' && f.key !== '' && typeof f.name === 'string' && f.name !== '' && f.type !== 'dir',
  )
  if (files.length === 0) return { saved: [], failed: [], seen: 0 }

  let dirExisted = true
  try {
    const { access, mkdir } = await import('node:fs/promises')
    try {
      await access(destDir)
    } catch {
      dirExisted = false
      await mkdir(destDir, { recursive: true })
    }
  } catch (err) {
    return { saved: [], failed: files.map((f) => f.name), seen: files.length }
  }
  void dirExisted

  const saved: PulledFile[] = []
  const failed: string[] = []
  for (const f of files) {
    // 目标文件名：只取 basename，防止沙箱里的路径穿越写出目标目录。
    const base = f.name.split(/[\\/]/).pop() ?? f.name
    if (base === '' || base === '.' || base === '..') {
      failed.push(f.name)
      continue
    }
    const url = await getSandboxFileUrl(sid, sessionId, f.key)
    if (url === undefined) {
      failed.push(f.name)
      continue
    }
    const bytes = await downloadSandboxFile(url)
    if (bytes === undefined) {
      failed.push(f.name)
      continue
    }
    try {
      const { writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      await writeFile(join(destDir, base), bytes)
      saved.push({ key: f.key, name: base, size: bytes.byteLength })
    } catch (err) {
      log(`wpslingxi artifact write failed ${base}: ${(err as Error).message}`)
      failed.push(f.name)
    }
  }
  return { saved, failed, seen: files.length }
}

/** 渲染回传给模型/用户的 Markdown 摘要（空结果返回 ''）。 */
export function renderPullSummary(result: PullResult, destDir: string): string {
  if (result.saved.length === 0 && result.failed.length === 0) return ''
  const lines: string[] = ['', '', '> 📁 **沙箱产出已回传到本机**：`' + destDir + '`']
  for (const f of result.saved) lines.push(`> - \`${f.name}\` (${f.size} 字节)`)
  for (const f of result.failed) lines.push(`> - \`${f}\` （下载失败）`)
  return lines.join('\n')
}
