# 可切换工具/模型 + Fork Session 设计文档

> 适用项目：`/home/joysort/claudecodeui`（Claude Code UI / cloudcli）
> 状态：设计稿（design only，未改业务代码）
> 文档约定：技术名词、字段名、路径、函数签名一律用英文原文，并标注 `file:line`。所有行号均基于撰写时仓库 `main` 分支 commit `b988e0d` 核对。

---

## 0. 已拍板决策（项目负责人）

1. **「换 model 不换 provider」不算 fork**：仍是同一 session 的 resume，只是带上用户新选的 model。只有「换 provider」才 fork。
2. **历史超 token 上限时仅截断**：保头保尾 + 中间省略 + 工具输出截断，不引入摘要模型（无额外依赖/失败点）。
3. **resume 时必须支持显式切换模型，且对所有 provider 生效（含 claude / codex）**。判定规则统一为 `explicitModel` 信号：
   - 用户**没动**模型选择器（直接回复）→ `explicitModel=false` → **不传 model 覆盖**，用 session 自身模型（opencode 表现为不传 `--model`，修复 Bug1；claude/codex 保持各自现状，零回归）。
   - 用户**主动改了**模型（如 haiku → Opus）→ `explicitModel=true` → **必须把新 model 传下去**，让该 provider 在 resume 时换用新模型。
   - 因此「resume 换模型」是**两个动作之一**（另一个是「换工具→fork」），前端必须**明确区分**：换 provider=fork，仅换 model=resume+传新 model，都没动=resume 不传 model。详见 §4.1、§5.2。

---

## 1. 背景与目标 / 非目标

### 1.1 背景

当前 cloudcli 支持多个 coding agent provider（`claude` / `codex` / `opencode` / `cursor` / `gemini`），但本次需求聚焦前三者。三者的执行模型完全一致——**one-shot per turn**：每条用户消息都会 spawn 一个全新进程跑一个 turn，然后进程退出；下一条消息再重新拉起并通过 provider 自带的 resume 机制接续。没有常驻进程。

- claude：`server/claude-sdk.js`，`query({...})` 调用一次（`server/claude-sdk.js:648` / `:657`），turn 结束发 `complete`（`server/claude-sdk.js:728`）；resume 通过 SDK option `resume = sessionId`（`mapCliOptionsToSDK`，`server/claude-sdk.js:221-223`）。
- codex：`server/openai-codex.js`，`thread.runStreamed(command, ...)`（`server/openai-codex.js:289`）；resume 通过 `codex.resumeThread(sessionId, threadOptions)`（`server/openai-codex.js:265`）。
- opencode：`server/opencode-cli.js`，`spawnOpenCode` 跑 `opencode run --format json [--session <id>] [--model <m>] <prompt>`（`server/opencode-cli.js:237-256`），`close` 事件 resolve（`server/opencode-cli.js:282`）。

**sessionId 由工具自己生成**：前端首条消息不带 id；工具生成后从输出回传，后端捕获并发 `session_created` 事件给前端：
- claude：`server/claude-sdk.js:692`
- codex：`server/openai-codex.js:307`
- opencode：`registerSession` → `server/opencode-cli.js:185-193`

> **关键约束：应用无法预先指定 sessionId。** 任何「先建 DB 行再 spawn」的方案都行不通；新 session 的真实 id 只能在工具首轮输出后拿到。这一点直接决定了 fork 的落库时机（见 §3、§7b）。

### 1.2 目标

1. UI 上可选择 tool（claude / opencode / codex）与 model。
2. DB 中存储每个 tool 的 available models 与 default model。
3. 用户什么都不选 → resume 现有 session（保持现状行为），并顺带修掉 Bug1 崩溃。
4. 用户选的 tool 与该 session 原 provider 不同 → 提取该 session 历史，作为**一条新对话**发给新 tool；此后会话 id 变成新 tool 生成的 id。**切换 tool = fork 出新 session。**
5. 会话列表显示 fork 标记；DB 记录新会话并带 lineage 回指源会话。
6. 修复 Bug1：opencode（及其它工具）resume 时，前端把本机未认证的坏默认 model（`anthropic/claude-sonnet-4-5`）当 `--model` 传过去，导致 `opencode run` exit 1。

### 1.3 非目标

- 不做 provider 进程常驻化 / 真正的 in-place model 热切换。
- 不做跨 provider 的「无损」历史导入（三者都没有原生导入 API，只能拼进首轮 prompt，见 §6）。
- 不改动 `cursor` / `gemini` 的既有行为（Bug1 修复必须对它们零影响）。
- 不实现 fork 的「双向合并」或 session 树的复杂可视化，只做单向 lineage + 徽章。

---

## 2. 术语：resume vs fork

| 术语 | 精确定义 |
|---|---|
| **resume** | 用户在同一 provider 内继续一条已有 session。请求带 `sessionId` 且 `targetProvider === sourceProvider`。后端用 provider 原生 resume（`resume=`/`resumeThread`/`--session`）接续，**sessionId 不变**，DB 行不新增。 |
| **fork** | 用户为一条已有 session 选了**不同的 provider**。后端从源 session 抽取历史（`sessionsService.fetchHistory`），序列化成一段 prompt，作为新对话**不带 sessionId** 地 spawn 目标 provider。目标工具生成一个**全新 sessionId**；该 id 写入 `sessions` 表，并带 `forked_from` / `forked_from_provider` / `forked_at` 指回源 session。此后这条会话归属目标 provider。 |
| **lineage** | 新 session 行上记录的「源 session 指针」三元组：`forked_from`（源 session_id）、`forked_from_provider`（源 provider）、`forked_at`（fork 时间戳）。 |

> 注意：本设计中「换 model 但 provider 不变」**不算 fork**，仍是 resume，只是显式带上用户选的 model（走 §4.1 修复后的解析逻辑）。只有「换 provider」才 fork。这是与项目负责人需要确认的边界之一（见 §9 开放问题）。

---

## 3. 数据模型设计

应用自身 DB 路径：`~/.cloudcli/auth.db`（默认值见 `server/load-env.js:30`，可被 `DATABASE_PATH` 覆盖 `server/load-env.js:32-34`）。连接在 `server/modules/database/connection.ts`，schema 在 `server/modules/database/schema.ts`，迁移在 `server/modules/database/migrations.ts`。

### 3.1 迁移机制现状（务必遵循）

`migrations.ts` **没有版本号表**，也没有「migration N 已执行」记账。它走的是**幂等结构修复**模式：
- 新增列：`addColumnToTableIfNotExists(db, table, columnNames, name, type)`（`server/modules/database/migrations.ts:26-37`），先读 `PRAGMA table_info`，列不存在才 `ALTER TABLE ... ADD COLUMN`。
- 整表重建：当主键/必需列缺失时走 `*__new` 重建 + 数据搬迁（如 `rebuildSessionsTableWithProjectSchema`，`server/modules/database/migrations.ts:238-383`）。
- 入口 `runMigrations(db)`（`server/modules/database/migrations.ts:404-455`）每次启动都跑一遍，靠幂等保证安全。

因此本次新增**不要引入版本号机制**，沿用同样的幂等风格即可。

### 3.2 `sessions` 表新增 lineage 列

`sessions` 表当前定义见 `server/modules/database/schema.ts:82-97`，列为：
`session_id`(PK) / `provider`(DEFAULT 'claude') / `custom_name` / `project_path`(FK→projects) / `jsonl_path` / `isArchived` / `created_at` / `updated_at`。

新增三列（均可空，旧行保持 NULL 即「非 fork」）：

| 列 | 类型 | 含义 |
|---|---|---|
| `forked_from` | `TEXT` | 源 session_id |
| `forked_from_provider` | `TEXT` | 源 provider（如 `'opencode'`） |
| `forked_at` | `DATETIME` | fork 发生时间 |

**Schema 源文件同步**：把这三列加进 `SESSIONS_TABLE_SCHEMA_SQL`（`schema.ts:82-97`）以及 `rebuildSessionsTableWithProjectSchema` 内 `CREATE TABLE sessions__new (...)` 的列定义（`migrations.ts:305-320`），并在该函数的搬迁 SELECT/INSERT 中带上这三列（`migrations.ts:321-373`，对历史行用 `NULL` 兜底，仿照现有 `jsonlPathExpression` 写法 `migrations.ts:285-287`）。

**迁移 SQL**（加进 `runMigrations`，紧跟 `rebuildSessionsTableWithProjectSchema(db)` 之后，`migrations.ts:429` 附近）：

```ts
// inside runMigrations(db), after rebuildSessionsTableWithProjectSchema(db)
const sessionsInfo = getTableInfo(db, 'sessions');
const sessionsColumns = sessionsInfo.map((c) => c.name);
addColumnToTableIfNotExists(db, 'sessions', sessionsColumns, 'forked_from', 'TEXT');
addColumnToTableIfNotExists(db, 'sessions', sessionsColumns, 'forked_from_provider', 'TEXT');
addColumnToTableIfNotExists(db, 'sessions', sessionsColumns, 'forked_at', 'DATETIME');
```

可选索引（用于「列出某源 session 的所有 fork」回链查询）：

```ts
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_forked_from ON sessions(forked_from)');
```

**与后台同步器的关系（防止 lineage 被清空）**：`sessionsDb.createSession` 用 `ON CONFLICT(session_id) DO UPDATE`（`server/modules/database/repositories/sessions.db.ts:56-74`），后台同步器 `sessionSynchronizerService`（`session-synchronizer.service.ts`）会周期性 re-upsert 各 provider 存储扫到的 session。当前 upsert 的 `DO UPDATE SET` 子句**没有触碰**这三个新列，所以默认就不会覆盖。**但必须保证 lineage 列永远不出现在任何 `DO UPDATE SET` 里**（即 upsert 不写 lineage，只有 fork 落库那一处显式写）。这正是利用「ON CONFLICT 不更新未列出的列」的语义来保护 lineage。

### 3.3 新表 `provider_models`

**目的**：把「每个 provider 的 available models 列表 + default model」落进 DB，作为模型目录的**权威可控副本**。

当前模型目录来自 provider class 的 `getSupportedModels()`（如 opencode 的 `server/modules/providers/list/opencode/opencode-models.provider.ts:273`），经 `providerModelsService` 缓存于 `~/.cloudcli/provider-models-cache.json`（`provider-models.service.ts:43-47`，TTL 3 天 `:18`，version 1 `:19`）。**目前确实没有任何 DB 表存 available/default models。**

**表定义**：

```sql
CREATE TABLE IF NOT EXISTS provider_models (
    provider        TEXT NOT NULL,          -- 'claude' | 'codex' | 'opencode' | ...
    model_value     TEXT NOT NULL,          -- e.g. 'anthropic/claude-sonnet-4-5'（对应 ProviderModelOption.value）
    model_label     TEXT NOT NULL,          -- 人类可读名（对应 ProviderModelOption.label）
    model_description TEXT,                  -- 可空（对应 ProviderModelOption.description）
    is_default      INTEGER NOT NULL DEFAULT 0,  -- 该 provider 的 default model 标记
    is_available    INTEGER NOT NULL DEFAULT 1,  -- 软下线开关，便于隐藏未认证/弃用模型
    sort_order      INTEGER NOT NULL DEFAULT 0,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, model_value)
);
CREATE INDEX IF NOT EXISTS idx_provider_models_default
    ON provider_models(provider, is_default);
```

- **主键**：复合主键 `(provider, model_value)`，保证同一 provider 内 model 唯一、upsert 幂等。
- **default 约束**：SQLite 不便用部分唯一索引强制「每 provider 仅一个 default」。改由写入层保证：seed/更新 default 时先 `UPDATE provider_models SET is_default=0 WHERE provider=?`，再把目标行置 1（单事务）。
- **字段映射**：直接对应 `ProviderModelsDefinition`（`server/shared/types.ts:82-85`）= `{ OPTIONS: ProviderModelOption[]; DEFAULT: string }`，其中 `ProviderModelOption` 含 `value` / `label` / `description?`（见 `provider-models.service.ts:58-69` 的类型守卫）。

**Seed 流程**（首次启动 / provider 目录刷新时）：
1. 调 `providerModelsService.getProviderModels(provider)`（`provider-models.service.ts:235-271`）拿到 `ProviderModelsDefinition`（它内部已处理 memory→disk cache→`getSupportedModels()` fresh 三级回退）。
2. 把 `OPTIONS` 逐行 upsert 进 `provider_models`（`ON CONFLICT(provider, model_value) DO UPDATE SET label/description/is_available/sort_order/updated_at`）。
3. 把 `DEFAULT` 对应的 `model_value` 置 `is_default=1`（其余清 0，单事务）。
4. seed 不删除「目录里已消失但仍被某 session 引用」的 model 行（避免历史 session 模型名解析失败），只把它们 `is_available=0`。

**与 localStorage / JSON 缓存的关系——取舍：并存，分工明确（不取代）。**

| 存储 | 角色 | 是否保留 |
|---|---|---|
| `provider_models`（新 DB 表） | **权威可控目录 + default**：跨设备/跨浏览器一致，可被运维直接改 DB 调整可选模型与 default，且为 fork 时「目标 provider 的 default model」提供服务端真相 | 新增 |
| `~/.cloudcli/provider-models-cache.json` | provider 上游目录的**临时性能缓存**（TTL 3 天），仍是 `getSupportedModels()` 的落盘缓存层 | 保留（作为 seed 的上游来源） |
| localStorage `selected-provider` / `claude-model` / `codex-model` / `opencode-model` | **纯前端 UI 偏好**（用户上次选了什么），不是真相来源 | 保留 |
| `~/.cloudcli/provider-session-active-model-changes.json` | per-session model 覆盖（resume 时优先生效），见 `resolveResumeModel`（`provider-models.service.ts:290-306`） | 保留 |

**取舍理由**：JSON cache 的语义是「上游目录的过期可重取缓存」，不适合承载「运维想长期固定的可选集合 + default」这种**意图性配置**；DB 表承载意图，JSON cache 承载性能。前端 model 下拉框的数据源改为「优先 DB `provider_models`，缺失时回退 `GET /api/providers/<p>/models`」。**default model 的服务端真相统一以 `provider_models.is_default` 为准**——这恰好替代了 §4.1 里那个写死的坏默认。

---

## 4. 后端设计

### 4.1 Bug1：resume 路径的模型解析修复

**根因**：`resolveResumeModel(provider, sessionId, requestedModel)`（`provider-models.service.ts:290-306`）当前逻辑是：若有 per-session 覆盖（`getChangedActiveModel`，`:300-303`）就用覆盖值，**否则原样返回前端传来的 `requestedModel`**（`:305`）。而前端 opencode 永远会带上 `opencodeModel`（`useChatComposerState.ts:723`），其值在用户没主动改时来自 localStorage / provider 目录 `DEFAULT`（opencode 的 `DEFAULT = 'anthropic/claude-sonnet-4-5'`，`opencode-models.provider.ts:65`）。本机若没认证该模型，opencode-cli 把它当 `--model` 传入（`server/opencode-cli.js:241-243`）→ `opencode run` exit 1 → 续聊失败。

**修复（服务端权威，前端为辅）**：把 `resolveResumeModel` 改成「resume 且用户未显式改模型时，不要相信前端默认」。新增「是否用户显式选择」的信号，并把 DB default 接进兜底链：

```ts
// resolveResumeModel 的新优先级（resume 既有 session 时）：
// 1) per-session active-model override（用户在该 session 上显式改过模型）→ 用它
// 2) 用户在本次请求里"显式"选择的 model（带 explicitModel:true 标记）→ 用它
// 3) 否则 → 返回 undefined（即"不传 --model"），让 provider 用 session 自身记录的模型
//    若某 provider resume 必须带 model，则回退到 provider_models 里该 provider 的 is_default
```

落地要点：
- **请求层加 `explicitModel` 布尔**：前端只有当用户**主动操作过 model 选择器**时才置 `true`（见 §5）。`resolveResumeModel` 多收一个 `explicitModel` 参数；当 `sessionId` 存在、无 per-session 覆盖、且 `explicitModel !== true` 时返回 `undefined`。
- **opencode 省略 `--model`**：`server/opencode-cli.js:241-243` 已经是「`if (resolvedModel) args.push('--model', resolvedModel)`」，所以 `resolveResumeModel` 返回 `undefined` 时天然不传 `--model`，opencode 会用它 session 记录里的模型——正是期望行为，无需改 opencode-cli 这段分支逻辑本身。
- **DB default 兜底**：仅当某 provider 在 resume 时**必须**带 model（claude SDK / codex 视实现而定）才回退 `provider_models.is_default`；opencode 走「省略」即可。

**resume 显式换模型——必须对所有 provider 生效（决策 0.3）**：

`resolveResumeModel` 目前**只有 opencode 调用**（`server/opencode-cli.js:236`）；claude（`claude-sdk.js`）与 codex（`openai-codex.js`）并不经过它（grep 确认）。但负责人要求「resume 时切模型（如 haiku→Opus，这是 **claude** 的场景）必须能用」，所以 claude / codex 的 resume 路径**也要接入** `explicitModel` 判定：

| provider | `explicitModel=false`（用户没动模型） | `explicitModel=true`（用户主动改了模型） |
|---|---|---|
| **opencode** | `resolveResumeModel` 返回 `undefined` → 不传 `--model` → 用 session 自身模型（修复 Bug1） | 传用户选的 model 到 `--model` |
| **claude** | 保持**现状**：仍按当前逻辑（前端传的 model / SDK 默认），**不改行为 → 零回归** | 把用户选的 model 作为 SDK resume 的 model 传下去（实现 haiku→Opus 切换） |
| **codex** | 保持**现状**：不改行为 → 零回归 | 把用户选的 model 传给 `resumeThread` 的 threadOptions |

落地要点：
- **零回归底线**：只有当 `explicitModel===true` 时才改变 claude/codex 既有的 model 取值；`explicitModel!==true` 时三者都走「各自现状」（opencode=不传，claude/codex=原逻辑）。cursor/gemini 不在本次改动范围，保持不动。
- **统一信号**：claude/codex 不强制都改走 `resolveResumeModel`，但**必须共享同一个 `explicitModel` 语义**——可在各自 spawn 入口加最小判断：`explicitModel ? useUserModel : keepCurrentBehavior`。opencode 走完整的 `resolveResumeModel(provider, sessionId, model, explicitModel)`。
- **per-session override 仍最高优先**：若该 session 有 active-model override（`provider-session-active-model-changes.json`），无论 explicit 与否都先用它（保持现有语义）。「用户改了模型」这个动作本身也应写入该 override，使下一轮即便 `explicitModel=false` 也延续新模型（避免切到 Opus 后下一句又退回 haiku）。

### 4.2 Fork 路径：新的 WS 消息 / 字段设计

**复用既有 command 通道**，在 options 里加 fork 字段，而不是新增一类 message type（降低 `chat-websocket.service.ts:121-144` 分发改动面）。新增 options 字段：

```ts
options: {
  // ...既有字段...
  fork: true,                       // fork 标志
  sourceSessionId: string,          // 源 session_id
  sourceProvider: LLMProvider,      // 源 provider
  // targetProvider 即消息 type 决定（如 'codex-command' → codex）
  model?: string,                   // 目标 provider 的初始 model（空则用 provider_models.is_default）
  explicitModel?: boolean,          // 见 §4.1
  // 注意：fork 请求"不带" sessionId（新 session id 必须由目标工具生成）
}
```

派发时机：当 `fork === true`，对应 `dependencies.queryClaudeSDK / queryCodex / spawnOpenCode` 在进入正常 spawn 前，先走一段「fork 预处理」（建议抽成 `forkSessionService`）。

**后端步骤（以 fork 到 opencode 为例）**：

1. **fetchHistory**：`sessionsService.fetchHistory(sourceSessionId, { limit: null })`（`sessions.service.ts:97-115`）→ `FetchHistoryResult`（`server/shared/types.ts:252-259`），其 `messages: NormalizedMessage[]`（结构见 `server/shared/types.ts:184-233`，关键字段：`role` / `content` / `kind` / `toolName` / `toolResult` / `timestamp`）。它内部按源 session 的 `provider` + `project_path` 自动选对的 provider reader（`sessions.service.ts:109-114`），三个 provider 都已实现 `fetchHistory`（各 `*-sessions.provider.ts`）。
2. **序列化**：把 `NormalizedMessage[]` 拼成一段「重放历史」文本（格式与截断见 §6），作为目标工具的**首条 prompt**。
3. **以新会话 spawn**：调目标 provider 的 spawn，**不带 sessionId**（`sessionId: undefined`、`resume: false`），`command` = 序列化后的历史 prompt（可在末尾接上用户本轮真正想说的话，如果 fork 同时附带了首句）；cwd 用源 session 的 `project_path`（opencode 还要注意 §8 的 cwd 约束）。
4. **捕获新 id**：目标工具首轮输出回传新 sessionId，后端照常发 `session_created`（claude `:692` / codex `:307` / opencode `:185-193`）。fork 预处理需要**拦截/感知**这个新 id（在 spawn 的 `ws.setSessionId` 回调或包一层 writer 钩子里拿到）。
5. **写 `sessions` 行 + lineage**：拿到新 id 后，用 `sessionsDb.createSession(newId, targetProvider, projectPath, ...)`（`sessions.db.ts:38-77`）落行，并**额外**执行一条 lineage 写入：

   ```sql
   UPDATE sessions
   SET forked_from = ?, forked_from_provider = ?, forked_at = CURRENT_TIMESTAMP
   WHERE session_id = ?;
   ```

   （或在 `sessionsDb` 新增 `markForked(newId, sourceSessionId, sourceProvider)` 方法承载这条 UPDATE，避免散落 SQL。）
6. **保证同步器不清 lineage**：见 §3.2——`createSession` 的 `ON CONFLICT DO UPDATE`（`sessions.db.ts:59-65`）与同步器 upsert **都不写** lineage 三列，故后续 re-upsert 不会清空。务必在后续任何 upsert 改动中坚持这一约束。

**各工具如何接收「重放历史」**：三者均无原生导入 API，**只能把历史拼进首条 prompt**：
- claude：作为 `query({ prompt })` 的首条 user message 文本。
- codex：作为 `thread.runStreamed(command, ...)` 的 `command`（`openai-codex.js:289`），不调 `resumeThread`。
- opencode：作为 `opencode run ... <prompt>` 的 prompt 位置参数（`server/opencode-cli.js:244-245`），不传 `--session`。

### 4.3 opencode error 写入 pm2 日志的改进点

现状：opencode `stderr` 直接转成 `kind:'error'` 推给前端（`server/opencode-cli.js:268-280`），exit code 非 0 时也会发 `complete`（`:303-309`）。问题是这些错误**没有结构化打到服务端日志**，运维只能从前端看。改进：
- 在 `stderr.on('data')`（`:268`）和 `close` 非 0 分支（`:311` 之后）加 `console.error('[OpenCode] exit=%d stderr=%s session=%s', code, stderrText, finalSessionId)`，使其进入 pm2 日志（cloudcli 由 pm2 托管，见 §11）。
- 把「`--model` 被拒绝」这类典型失败（exit 1 + stderr 含 model/auth 关键字）单独打一条告警级日志，便于定位 Bug1 类问题复发。

---

## 5. 前端设计

涉及 `src/components/chat/hooks/useChatComposerState.ts`（发送构造，`:666-743`）及 provider/model 选择相关 hooks（`useChatProviderState.ts` / `useSelectedProvider.ts`）。

### 5.1 Composer 的 tool + model 选择器

- 在 composer 增加 **tool 选择器**（claude / opencode / codex）与 **model 选择器**。
- 打开一条已有 session 时，**预填**：tool = 该 session 的 `provider`，model = 该 session 当前 model（per-session override 优先，否则 `provider_models.is_default`）。
- model 下拉数据源：优先 `provider_models`（经新 API，如 `GET /api/providers/<p>/models` 改为读 DB 表 + 回退目录），保证 default 与服务端一致。
- **`explicitModel` 信号**：仅当用户**手动点开并改过** model 选择器时，发送 options 里带 `explicitModel: true`；纯预填不算显式（配合 §4.1 修复）。

### 5.2 三态判定：换工具(fork) / 仅换模型(resume+model) / 都没动(resume)

打开一条已有 session 后，记下基线 `baseProvider = selectedSession.provider`、`baseModel = 该 session 当前 model`。发送时按下表三选一（决策 0.1 / 0.3）：

| 条件 | 动作 | 请求构造 |
|---|---|---|
| `selectedTool !== baseProvider` | **fork** | 清空 sessionId、`resume:false`、`fork:true` + `sourceSessionId/sourceProvider`，消息 type 用**目标 tool** 的 command。model 用目标 provider 的选择值（空则 `provider_models.is_default`）。 |
| 同 provider 且 `selectedModel !== baseModel` | **resume + 显式换模型** | 带 `sessionId`、`resume:true`、`model = selectedModel`、**`explicitModel:true`**。type 仍是原 provider command。 |
| 同 provider 且模型未变 | **纯 resume** | 带 `sessionId`、`resume:true`、**`explicitModel:false`**（model 字段可带可不带，后端因 `explicitModel:false` 会忽略它用 session 自身模型）。 |

- **`explicitModel` 的唯一真相**：是否等于「用户本次相对基线**真的改过** model 选择器」。仅仅因为预填把 model 填进了选择器**不算** explicit（否则每次都误判成换模型）。实现上用 `selectedModel !== baseModel` 判定，而不是「选择器有值」。
- **换模型要持久**：当判定为「resume + 显式换模型」时，前端除了本轮带 `explicitModel:true`，后端还应把新 model 写进该 session 的 active-model override（见 §4.1 末），使下一轮即使 `explicitModel:false` 也延续新模型，`baseModel` 同步更新为新值。

### 5.3 发送按钮 fork 提示

- 当 `isFork` 为真，发送按钮/输入区显示提示，例如「将以 {targetTool} 新建分支（fork from {sourceTool}）」，并在首次给一个轻确认（避免误触把贵的历史重放出去）。

### 5.4 fork 后切换活动会话到新 id

- fork 请求发出后，前端**不立即改路由**（因为新 id 还没生成）。
- 监听 `session_created`（newSessionId）：收到后把活动会话切到新 id，更新 URL/路由（`/session/:id`），并把 composer 的 tool 预填更新为目标 provider。
- 这与现有「首条消息后 session_created → 落地新 session」的路径一致，只是 fork 场景下源 session 仍保留在列表（带它自己的历史）。

### 5.5 会话列表 fork 徽章与回链源会话

- 侧栏 session summary 当前由 `mapSessionRowToSummary`（`projects-with-sessions-fetch.service.ts:129-136`）产出，字段 `id/summary/messageCount/lastActivity`。需扩展该 summary，带上 `forkedFrom` / `forkedFromProvider` / `forkedAt`（从新列读取）。
- 列表项若 `forkedFrom` 非空，渲染一个 **fork 徽章**（如分支图标 + 源 provider 名）。
- 徽章可点击 → 跳到源 session（用 `forkedFrom` + `forkedFromProvider` 定位），实现回链。

---

## 6. 历史序列化与 token 预算

### 6.1 序列化格式

把 `NormalizedMessage[]`（`server/shared/types.ts:184-233`）压成一段对人类与模型都可读的转写，作为目标工具首条 prompt 的前缀。建议格式：

```
[Forked conversation history — replayed from {sourceProvider} session {sourceSessionId}]
The following is a prior conversation. Continue it as if it were your own context.

## User
{message.content}

## Assistant
{message.content}

## Tool ({toolName})
{toolResult.content}   # 截断/省略大块工具输出
...
[End of replayed history. Now continue.]
```

序列化规则：
- 只取 `role`/`content` 为主的可读消息（`kind` 为 `text` / `stream_delta` 聚合后的最终文本）。
- `tool_use` / `tool_result`（`kind`、`toolName`、`toolResult.content`，见 `types.ts:208-215`）**摘要化**：保留工具名与简短结果，截断超长 stdout（工具输出往往是 token 大户）。
- `thinking`、空消息、纯 stream delta 中间态略过。

### 6.2 token 预算与截断 / 摘要策略

源历史可能远超目标模型上下文。策略（从轻到重）：
1. **预算上限**：设目标 prompt 软上限（如 ~50%~60% 目标模型 context window；以字符/粗略 token 估算）。
2. **保头保尾**：优先保留最早的若干轮（建立背景）与最近的若干轮（当前焦点），中间用 `[... N earlier turns elided ...]` 占位。
3. **工具输出激进截断**：tool_result 单条超过阈值即截断并标注省略字节数。
4. **（可选）轻量摘要**：超长时调一个轻量模型对中间段做摘要，替换被 elide 的部分。属增强项，默认走「保头保尾 + 截断」即可，避免引入额外模型依赖与失败点。
5. **截断可见性**：在重放 prompt 顶部标注「history was truncated」，并在前端 fork 提示里告知用户历史被压缩。

---

## 7. 时序图

### (a) 普通 resume（同 provider，含 Bug1 修复后的 model 解析）

```
User          Frontend(composer)        WS dispatch              opencode-cli            provider-models.service
 |  type msg        |                        |                         |                          |
 |----------------->|                        |                         |                          |
 |   send (resume)  | type:'opencode-command'|                         |                          |
 |                  | options:{sessionId, resume:true,                 |                          |
 |                  |          model, explicitModel:false}             |                          |
 |                  |----------------------->|                         |                          |
 |                  |                        | spawnOpenCode(...)      |                          |
 |                  |                        |------------------------>| resolveResumeModel(      |
 |                  |                        |                         |  'opencode',sessionId,    |
 |                  |                        |                         |  model, explicitModel)    |
 |                  |                        |                         |------------------------->|
 |                  |                        |                         |  no per-session override |
 |                  |                        |                         |  & explicit=false        |
 |                  |                        |                         |<--- returns undefined ---|
 |                  |                        |  opencode run --format json --session <id> <cmd>   |
 |                  |                        |  (NO --model → uses session's own model)           |
 |                  |                        |   stream_delta / text ... complete                 |
 |<----------------------- streamed output / complete ------------------------------------------- |
```

关键点：`resolveResumeModel` 返回 `undefined` → opencode 不带 `--model`（`opencode-cli.js:241-243`）→ 用 session 自身模型 → 不再因坏默认 exit 1。

### (b) 切换工具 fork（含「先发首轮 → 拿到新 id → 写 lineage」这一无法预先指定 id 的关键点）

```
User      Frontend            WS / forkSessionService     sessionsService.fetchHistory   targetTool(codex)   sessions DB
 | switch tool→codex |                  |                          |                          |                 |
 | (source=opencode) |                  |                          |                          |                 |
 |------------------>|                  |                          |                          |                 |
 |   send (fork)     | type:'codex-command'                       |                          |                 |
 |                   | options:{ NO sessionId, resume:false,      |                          |                 |
 |                   |   fork:true, sourceSessionId, sourceProvider:'opencode', model }       |                 |
 |                   |----------------->|                          |                          |                 |
 |                   |                  | fetchHistory(sourceSessionId)                       |                 |
 |                   |                  |------------------------->|                          |                 |
 |                   |                  |   NormalizedMessage[]    |                          |                 |
 |                   |                  |<-------------------------|                          |                 |
 |                   |                  | serialize+truncate (§6)  |                          |                 |
 |                   |                  | spawn codex WITHOUT sessionId, command=<history prompt>                |
 |                   |                  |---------------------------------------------------->|                 |
 |                   |                  |        (codex generates a brand-new threadId)       |                 |
 |                   |                  |<-------- session_created(newSessionId) -------------|                 |
 |  <----------------|<-- relay session_created (frontend switches route to newId) ---------- |                 |
 |                   |                  | createSession(newId,'codex',projectPath)            |                 |
 |                   |                  | markForked(newId, sourceSessionId,'opencode')       |                 |
 |                   |                  |---------------------------------------------------------------------->|
 |                   |                  |        sessions row: forked_from / forked_from_provider / forked_at  |
 |                   |                  |   ...streamed assistant output... complete          |                 |
```

关键点：**新 sessionId 只能在 codex 首轮输出后才存在**，所以「写 `sessions` 行 + lineage」必须发生在 `session_created` 之后，无法预先建行。前端的路由切换同样由 `session_created` 触发。

---

## 8. 边界与风险

1. **sessionId 不可预指定**：fork 必须「先 spawn 拿 id 再落库」。若首轮失败（工具 exit 非 0、未生成 id），则不写 `sessions` 行，源 session 保持不变；前端提示 fork 失败，不切路由。需处理「拿不到新 id」的超时兜底。
2. **长历史 / token 上限**：见 §6。最坏情况是源历史远超目标 context；必须截断，且要让用户知情。摘要模型若失败要能降级到纯截断。
3. **opencode 的 cwd 约束**：`readOpenCodeSessionDirectory(sessionId)`（`server/opencode-cli.js:92-123`）从 opencode sqlite 读 session 的 `directory`/`worktree`，resume 时强制用它当 cwd（`:131-132`）。**fork 到 opencode 是"新建"，没有源 opencode session 目录**，因此 cwd 必须用源 session 的 `project_path`（来自 `sessions` 表）或前端 cwd；不要错误地对一个还不存在的新 opencode session 调 `readOpenCodeSessionDirectory`。反向（从 opencode fork 出去）则用源 opencode session 的目录作为新工具的 cwd。
4. **同步器 re-upsert**：见 §3.2。lineage 三列绝不能进任何 `DO UPDATE SET`，否则后台扫描会把它清掉。需在集成测试里固化这一点（§10）。
5. **目标工具模型未认证 / 不可用**：fork 时 `model` 应优先取目标 provider 的 `provider_models.is_default`（已是本机可用的稳妥默认），避免重蹈 Bug1。若目标 provider 整体未认证/未安装（opencode 有 `isProviderInstalled` 检查，`opencode-cli.js:318`），fork 直接报错并提示，不落库。
6. **fork 的幂等与并发**：同一源 session 被快速双击 fork 两次会产生两条独立新 session（各自的新 id）——这在语义上可接受（两个分支），但 UI 应对「fork 进行中」加 in-flight 锁，防止误触重复重放（重放历史 = 真金白银的 token）。落库以新 id 为主键天然幂等（同一新 id 不会重复建行）。
7. **provider 列表耦合**：`bucketSessionRowsByProvider`（`projects-with-sessions-fetch.service.ts:138-158`）与同步器 `processedByProvider`（`session-synchronizer.service.ts:20-26`）都硬编码五个 provider key。新增 lineage 不改这个集合，但若以后加 provider 需同步这两处。

---

## 9. 分阶段实施计划

### 阶段 1：Bug1 修复 + DB 模型表

**交付物**
- `provider_models` 表 + 迁移（§3.3），seed 流程（从 `getProviderModels` 灌入）。
- `explicitModel` 信号端到端透传 + 三 provider 接入（§4.1 表）：opencode 走 `resolveResumeModel(..., explicitModel)`（false→不传 `--model`，修复 Bug1）；claude/codex 在各自 resume 路径加最小判断（false→现状零回归，true→传用户选的 model，实现 haiku→Opus 切换）。
- 「用户改模型」写入 per-session active-model override，使新模型在后续轮次延续（§4.1 末）。
- `GET /api/providers/<p>/models` 数据源改为「DB 表优先，目录回退」。

**验证**
- Bug1：本机**未认证** `anthropic/claude-sonnet-4-5` 时，resume 一条 opencode session（不动模型）不再 exit 1、正常续聊。
- 显式换模型：claude session 把模型从 haiku 改成 Opus 后 resume，确实换用 Opus；下一轮不动模型仍保持 Opus（override 生效）。
- 零回归：cursor / gemini 行为不变；claude / codex 在「未显式改模型」时行为与改造前一致。

### 阶段 2：fork 后端 + lineage

**交付物**
- `sessions` 表 lineage 三列 + 迁移（§3.2）。
- `forkSessionService`：fetchHistory → 序列化（§6）→ 无 sessionId spawn → 捕获新 id → `createSession` + `markForked`。
- WS options 增加 `fork/sourceSessionId/sourceProvider`，三个 provider 的 spawn 接入 fork 预处理。
- opencode 错误打 pm2 日志（§4.3）。

**验证**
- 从 opencode session fork 到 codex：生成新 codex session，DB 行带正确 lineage，源 session 不变。
- 触发一次后台同步器，确认 lineage 列未被清空。
- 历史截断在超长 session 上生效，不撑爆目标模型。

### 阶段 3：前端两级选择器（工具 + 模型）+ fork 徽章

> 用户反馈并入：① 新建对话"模型搜索空白"（已修，见 §13 进展）；② 需要**两级选择**（先工具、再该工具下的具体模型）；③ **已有对话完全没有改 tool/model 的入口**，必须补。两级选择器同时服务"换模型=resume"与"换工具=fork"。

**交付物**
- **抽出可复用组件** `ToolModelSelector`：从 `ProviderSelectionEmptyState.tsx:124-296` 已有的 Command 分组渲染（provider 分组 + 可搜索模型列表）提取，新建/已有两场景共用，避免两套实现。数据源 `providerModelCatalog`（`/api/providers/<p>/models`，DB 优先）。
- **新建对话**：`ProviderSelectionEmptyState` 内嵌该组件（它本就是这用途，cache 修复后即可正常显示并搜索全部模型）。
- **已有对话入口**（新增，关键缺失）：在 `ChatComposer.tsx:358` 后的 `PromptInputTools` 区挂一个紧凑触发钮（显示当前 `provider · model`），点开同一个 `ToolModelSelector`。需把 `provider/setProvider`、各 model state、`providerModelCatalog`、`selectProviderModel`、`selectedSession` 从 `ChatInterface.tsx` 透传进 `ChatComposer`（目前未传）。
- **三态接线**（§5.2）：选择器 `onSelect(provider, model)` —— 同 provider 换 model → resume + `explicitModel`（并 `selectProviderModel` 写 session override 持久化）；换 provider → fork 请求（`fork:true`+`sourceSessionId`+`sourceProvider`，清 sessionId）。**注意**：前端 `useChatComposerState.ts:717-799` 五个 send 分支目前**完全没有 fork 字段**，需在此补齐。
- fork 提示与 in-flight 锁（§5.3、§8.6）；`session_created` 后切路由到新 id（§5.4）；侧栏 fork 徽章 + 回链（§5.5），summary 扩展 lineage 字段。

**验证**
- 新建对话：能看到工具分组 + 每个工具下可搜索的模型列表（不再空白）。
- 已有对话：composer 出现"工具·模型"入口；同工具换模型 → resume 用新模型；换工具 → fork 新 session。
- 端到端 fork：换 tool → fork 提示 → 发送 → 路由切到新 session → 侧栏 fork 徽章 → 点徽章回源 session。
- 纯 resume（未改 tool/model）走老路径，零行为变化。

---

## 10. 测试计划

**单元测试**
- `resolveResumeModel`：覆盖 (a) 有 per-session override、(b) `explicitModel:true` → 用用户选的 model、(c) resume 无 override 且 `explicitModel:false` → 返回 `undefined`（opencode 不传 `--model`）、(d) 无 sessionId（新对话）→ 用 requestedModel。
- claude/codex 显式换模型：`explicitModel:true` 时 resume 用新 model（haiku→Opus）；`explicitModel:false` 时取值与改造前一致（零回归对照）。
- 换模型持久化：显式换模型后写入 active-model override，下一轮 `explicitModel:false` 仍解析到新 model。
- `provider_models` repo：upsert 幂等、`is_default` 唯一性（置新 default 会清旧）、`is_available=0` 软下线。
- 历史序列化：空历史、超长历史截断、tool_result 截断、保头保尾正确。
- `markForked` / lineage 写入：写后 `getSessionById` 能读回三列。
- 同步器不清 lineage：建一条 forked session，跑 `sessionSynchronizerService.synchronizeSessions()`（或针对性 upsert），断言 `forked_from` 仍在（参考既有 `sessions.db.integration.test.ts`）。

---

## 13. 实施进展（live）

**阶段 1（已完成并上线）** commit `0322d8d`：
- `provider_models` 表 + 启动 seed（164 模型 / 5 provider）+ models API DB 优先。
- `explicitModel` 信号全链路；`resolveResumeModel(provider, sessionId, model, explicitModel)`。
- cursor/gemini 经 `|| model` 兜底零回归（注：实测 `resolveResumeModel` 被全部 5 个 provider 调用，早期"仅 opencode"判断有误，已纠正）。

**opencode 健壮性修复（已完成并上线）** commit `55ceda4`：
- **脏模型自愈**：resume 时若会话存的模型无效/未认证（如脏数据 `anthropic/claude-sonnet-4-5`），自动用 opencode 有效默认（`opencode/big-pickle`，已验证 exit 0）**重试一次**，对标 opencode TUI 的回退恢复；只重试一次、无死循环。这修正了阶段 1「省略 --model → 用脏模型直接崩」的不足。
- **错误如实透传**：读 `error.data.message`，不再吞成 "Unknown OpenCode error"（曾误显为"找不到对话"）。`opencode-sessions.provider.ts`。
- **防卡死**：WS 兜底错误带 `kind:'error'` + 前端 legacy(no-kind) error 也清 loading（`useChatRealtimeHandlers.ts`），失败 turn 不再永久转圈。
- **模型列表空白回归修复**：DB-first API 的 `cache:null` 不再被前端判为无效（`useChatProviderState.ts`）。

**待办**：阶段 2（fork 后端 + lineage）、阶段 3（两级选择器 + fork UI，已并入用户 UI 反馈）。

**手动验证**
- Bug1：未认证默认模型环境下 opencode resume 续聊成功（核心验收）。
- fork：opencode→codex、codex→claude、claude→opencode 三向各跑一次，确认新 id、lineage、徽章、回链、路由切换。
- 回归：cursor/gemini 不受影响；纯换 model（同 provider）仍是 resume 不 fork。
- 并发：连点 fork 两次，确认 in-flight 锁或至少不产生脏数据。

---

## 11. 部署提醒

- **后端改动**（`server/**`，TS/JS）：cloudcli 实际从 `dist-server` 运行。改完必须 `npm run build`（或 `npm run build:server`）重新编译，**再**重启服务。重启用 `pm2 restart cloudcli`，且**不能让当前进程直接重启自己**——用 nohup 分离方式触发（例如 `nohup bash -c 'pm2 restart cloudcli' >/dev/null 2>&1 &`），避免重启杀掉发起重启的会话。
  - 记忆点（来自 MEMORY）：`server` 改动需 `npm run build:server` 后 `pm2 restart cloudcli`，否则 `dist-server` 仍是旧代码。
- **DB 迁移**：迁移在服务启动 `runMigrations` 时自动跑（幂等），重启即生效；建议先备份 `~/.cloudcli/auth.db`。
- **前端改动**（`src/**`）：`vite build` 后浏览器**硬刷新**（清缓存）才能看到新 composer/徽章。

---

## 附：本设计已核对的关键代码点（防漂移清单）

- 执行模型/spawn：`claude-sdk.js:648/657/692/728`、`openai-codex.js:265/289/307`、`opencode-cli.js:236-256/282/303-309`。
- sessionId 由工具生成 + `session_created`：`opencode-cli.js:185-193`、`claude-sdk.js:692`、`openai-codex.js:307`。
- 统一历史抽取：`sessions.service.ts:97-115`（`fetchHistory` 按 DB provider 选 reader）；`NormalizedMessage`：`shared/types.ts:184-233`；`FetchHistoryResult`：`shared/types.ts:252-259`。
- DB：`load-env.js:30-34`、`schema.ts:82-97`（sessions schema）、`migrations.ts:26-37`（ADD COLUMN 模式）/`:238-383`（rebuild）/`:404-455`（入口，无版本表）、`sessions.db.ts:38-77`（createSession ON CONFLICT/COALESCE upsert）。
- 模型链路：`provider-models.service.ts:43-47`（JSON cache 路径）/`:235-271`（getProviderModels 三级回退）/`:290-306`（resolveResumeModel = Bug1 根源）；opencode `--model` 传参 `opencode-cli.js:241-243`；opencode 坏默认 `opencode-models.provider.ts:65`；前端发送构造 `useChatComposerState.ts:666-743`；WS 分发 `chat-websocket.service.ts:121-144`。
- opencode cwd 约束：`opencode-cli.js:92-123`（readOpenCodeSessionDirectory）/`:131-132`。
- 侧栏 summary：`projects-with-sessions-fetch.service.ts:129-136`（mapSessionRowToSummary）/`:138-158`（bucketSessionRowsByProvider）。
- 同步器：`session-synchronizer.service.ts:13-75`。
