# dsh-router-wpslingxi

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 **WPS 灵犀**（lingxi）供应商。

仿 [dsh-router-traework](https://github.com/CARVIN94/dsh-router-traework) 的独立供应商插件结构（自含契约，不依赖 dsh-router 包）。

> **凭证说明**：本插件用你自己的 `wps_sid` cookie 调上游，凭证只存在 DSH 本地凭证库
> （`~/.dsh/profiles/<profile>/data/auths/credentials.sqlite`），不进代码、不进仓库。
> 下面的调试记录里出现的 cookie 值都是本地抓包原文，**不要提交**（已在 `.gitignore` 里挡掉）。

## 能力（真机实测）

| 能力 | 状态 |
| --- | --- |
| 思考过程（reasoning） | ✅ `c_reasoning` → `reasoning_content` |
| 工具调用 | ✅ `c_execute_code` / `c_read_file` / `c_write_file` / `c_edit_file` / `c_list_files` / `c_install_package` / `c_websearch` / `c_urlfetch` |
| 真沙箱执行 | ✅ 代码真的跑，`full_content.output` 是真实 stdout |
| 模型选择 | ✅ `agent_input.expect_model`（11 个模型 key 实测可路由） |
| 思考强度 | ✅ `agent_input.reasoning_effort`（`low` / `high` / `max`） |
| 积分 | ✅ `run.end` 上报 `session_credit_consumed` |
| **产出文件回传本机** | ✅ 沙箱里生成的文件自动拉回会话工作目录 |

## 产出文件回传（沙箱 → 你的电脑）

灵犀的 `c_execute_code` 跑在**云端沙箱**（`/home/lingxi/workspace`），文件不会自己出现在你机器上 ——
界面里的「脚本已保存：`/home/lingxi/workspace/quicksort/quicksort.py`」指的是**沙箱内路径**。插件把这段补上了：

1. 发问时在用户消息末尾追加「产出目录」约定，让 agent 把文件**实际写入** `/home/lingxi/workspace/output`；
2. 本轮 `run.end` 之后，列该目录 → 取预签名直链 → 下载 → 落到**会话工作目录**（cwd）；
3. 在回答末尾追加一段回传摘要：

   ```markdown
   > 📁 **沙箱产出已回传到本机**：`D:\your\project`
   > - `merge_sort.py` (1608 字节)
   ```

实测：问「用 Python 实现归并排序，把脚本保存下来并运行验证」，本机目录里真的出现 `merge_sort.py`（1608 字节）。

**为什么必须显式约定路径**：实测 prompt 只说「脚本要保存成文件方便我拿走」时，agent **不会落盘** ——
`/home/lingxi/workspace/output`、`/home/lingxi/workspace`、`/tmp` 全是空的，它只在回答里贴代码。
给了绝对路径才会真写文件。

回传是**尽力而为**的：列不到目录、取不到直链、下载失败都只记日志，不影响已经交给你的正文。

### 相关端点

```
GET  /api/aioffice/v1/sandbox/sessions/{sessionId}/files?path=<绝对路径>
     → {"data":{"items":[{name,size,type,key,files?}]}}     # 目录项把子文件嵌在 items[].files
POST /api/aioffice/v1/sandbox/file/preview   {key, session_id}
     → {"data":{"url":"https://...oss....?Signature=...","ext":".txt"}}   # 预签名直链，不带 cookie 也能下
GET  <上面那个 url>                                            → 原始字节
```

> 反方向（本机 → 沙箱）也有：`POST /api/aioffice/v1/cowork/sessions/{id}/files`（multipart `path` + `file`），
> 但它把内容落到 `/home/lingxi/workspace/.lxenc/<base64>`，**对 agent 是隐形的**，所以插件不做上传。

## 工作方式：走 cowork WebSocket 通道

凭证仍是 `wps_sid` cookie（登录 [lingxi.wps.cn](https://lingxi.wps.cn) 后从 DevTools → Application → Cookies 复制）。面板「添加 API key」粘贴即可。

**注意 host 是 `lingxi.kdocs.cn`**（不是 `lingxi.wps.cn`）—— 同一个 cookie 两边都认，实测 200。

```
1) POST /api/aioffice/v1/cowork/sessions          {"{}"}  → data.session_id
2) wss  /api/aioffice/v1/cowork/sessions/{id}/sandbox/completions/ws   （Cookie 走握手头，Origin 必须 https://lingxi.kdocs.cn）
3) 发 {"event":"user.input","data":{"agent_input":{...},"headers":{...}}}
```

### 为什么必须走它（三条通道实测对比）

| 通道 | 思考 | 工具调用 | 会被劫持成 deep research |
| --- | --- | --- | --- |
| aigc `/completions` | ✗ | ✗ | ✗ |
| aigc `/expert_completion`（SSE） | ✗ | ✗ | **✔ 会**（跑 plan/research agent 流水线） |
| **aioffice `/cowork/.../ws`** | **✔** | **✔ 真执行** | ✗ |

只有 cowork 这条同时给出「思考 + 工具调用 + 真执行」。

### 帧协议

服务端回一串 JSON 文本帧，`{"event":"...","data":{...}}`；**语义靠 `data.type` 区分**（这是与 SSE 通道最大的差别）：

```
run.start         {id, group_id}
component.start   {type, id, parent_id, group_id, payload?}
component.content {type, id, delta}                      增量
component.end     {type, id, full_content}               完整内容
turn.start/turn.end   {type, id, agent_time}
run.end           {id, credit_consumed, session_credit_consumed}
```

组件类型：

| type | 映射 |
| --- | --- |
| `c_reasoning` | → `reasoning_content` |
| `c_text` | → `content` |
| `c_execute_code` 等工具 | → 渲染成 Markdown 正文（带代码 + 真实 output） |
| `c_recommend` | 忽略 |

`c_execute_code` 的形状：

```jsonc
// component.start: {"payload":{"brief":"实现快速排序并运行示例数组"}}
// component.content: delta 逐段吐代码
// component.end:   {"full_content":{"arguments":{"code":"...","brief":"..."},
//                                    "output":"排序前: [...]\n排序后: [1, 3, ...]\n"}}
```

`output` 是**沙箱真实 stdout**。插件把工具调用渲染成：

```markdown
> 🔧 **执行代码：实现快速排序并运行示例数组**

```python
...代码...
```

**输出：**

```
排序前: [38, 27, 43, 3, 9, 82, 10, 55, 1, 64]
排序后: [1, 3, 9, 10, 27, 38, 43, 55, 64, 82]
```
```

### 控制面：agent_input

```json
{
  "text": "用户问题",
  "files": [], "refs": [],
  "expect_model": "qwen3.8_flash",
  "reasoning_effort": "low",
  "current_mode": "agent",
  "permission_mode": "default",
  "browser_plugin_enabled": false,
  "file_ids": [], "upload_ids": []
}
```

模型列表来自 `GET /api/aioffice/v1/sessions/plans` 的 `data.models`（`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`、`qwen3.8_flash`、`kimi-k3`、`GLM-5.3` …；`plans` 里的 `plan_pro`/`plan_max` 是「模式」不是模型）。

积分：`GET /api/public/v1/credits/balance?credit_type=total`，累加 `data.bonus_credits[].balance` + `data.purchased_credits[].balance`（没有 `total_balance` 字段）。

## 语义状态映射

| 上游信号 | AccountState |
| --- | --- |
| 401 / 403 | `session_dead` |
| 429 | `rate_limit` |
| 402 | `quota` |
| 404 | `unavailable` |
| HTTP 0（连不上） | `transport` |
| WebSocket 报错 | `transport`（走 onLateFailure） |
| 模型不在列表 | `no_such_model`（跳过供应商，不惩罚账号） |
| 请求体解析失败 / 空消息 | `bad_request`（不惩罚账号） |

`onLateFailure` **必须调用时读**（核心先跑 factory 再挂回调）。

## 安装

```bash
pnpm install && pnpm build
```

作为 DSH 插件安装（`cordis.patch.yml` 单行 insert，dsh bundle 机制自动挂载）。

> Windows 上跨盘无法用 `link:` 安装（pnpm 会把路径拼坏），用 `pnpm pack` 出 tgz 后在 profile 目录 `pnpm add <tgz>`。改源码后需 bump 版本号再重新 pack，否则 pnpm 复用旧缓存。

## 测试

```bash
pnpm test          # node --test（全部离线，WS 用注入的假实现）
pnpm typecheck
pnpm build
```

## 实现注意事项（踩过的坑）

- **`pull` 绝不能「空手返回」**：ReadableStream 只在**上一次 pull 解决且队列空**时才再次调用 pull。若 pull 消费了一帧却没有 enqueue 任何东西就返回（例如只碰到 `run.start` / `component.start`），读侧的 `read()` 会永远挂着 —— 表现为「只拿到第一条 role delta 后永久卡死」。必须循环到「产出数据」或「收尾」才返回。
- **stream 回调里的 `this` 是 underlying source，不是供应商实例**：写 `this.env.log(...)` 会让 `this.env` 是 undefined → 第一次 pull 抛 TypeError → 消费者永久等不到 done，且控制台一行日志都没有。一律用闭包捕获（`const log = this.env.log`）。
- **控制器只能 close 一次**：统一走带 `closed` 标志的 `finish(controller)`。
- **WS 是推模型、ReadableStream 是拉模型**：中间必须有队列 + `wake()` 唤醒，不能 busy-loop。
- **`c_execute_code` 的代码正文不要逐帧推**：`component.content` 阶段是半截代码，等 `component.end` 拿完整 `arguments.code` + `output` 一次性渲染。

## License

MIT
