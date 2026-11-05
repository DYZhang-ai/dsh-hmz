# DSH × hmz Flow 集成（外部插件 + 外置适配层）

外部 DSH 插件 `@dsh-hmz/flow`（`packages/dsh-hmz-flow`），让 DSH 通过 hmz 的公开 SDK 运行 hmz flow。
**hmz 源码、已安装 DSH 本体均零修改**；只用 DSH 公开插件接口（tools / guard / connection.fetch / slots / userQuestions / agent.followup）和 hmz 公开 SDK（`hmz.sdk.Hmz`、`Daemons`、`Link`）。

## 产品行为

- **DSH 入口 Agent 是 leader / 秘书。** 普通消息照常发给它；它判断用户意图，再调用 flow 工具。hmz 负责 flow 内部编排，leader 不充当 hmz 的角色。
- **选择 flow：** 两条入口，保存逻辑相同，都只做选择、不会启动：
  - 点输入框左下角的 **＋**，在“指令”里选 **Flow**，弹出窗口会列出当前目录的 hmz flow（已选中时还有“取消 flow 模式”）。这一入口通过 DSH 公开的 `commandUi.register` popupSelect 实现，不会动草稿。
  - 键入 `/`，在“添加 / 指令”之后的 **Flow** 分组里选一个 flow。
  选中后，输入框底部出现“**flow选项**”，点开后的面板由 hmz 的 flow 声明驱动：
  - 每个角色的 CLI / 账号 / 模型（可自填，带候选列表）/ effort；
  - 预算（费用、时间、输出 token，以及各自是否 graceful）、环境、params、profile 开关；
  - “附带前文”开关，默认开启。
  选项保存后即为权威；被清空的字段不会从 hmz 的记忆里回填。选中状态一直保留，直到取消 flow 模式。
- **leader 工具：**

  | 工具 | 作用 |
  |---|---|
  | `hmz_flow_list` | 列出可用 flow（只读） |
  | `hmz_flow_status` | 查询进度（只读） |
  | `hmz_flow_start` | 用户明确要求执行时启动，不额外确认；问进度只查询 |
  | `hmz_flow_send` | 按角色或 Agent 投递；绝不发空目标 |
  | `hmz_flow_answer` | 用 DSH 问答卡向真实用户提问，只转交用户自己的回答 |
  | `hmz_flow_stop` | 停止当前 run |

- **前文快照：** 只包含本会话中用户输入和助手可见文本，不含系统提示、注入上下文、工具调用和输出、思考过程。从最新消息往前取，单条最多 2000 字、总计最多 12000 字、最多 40 条，截断处会标注。
- **Flow 页（与“对话 / 轨迹”同级）只显示当前 DSH 会话的任务：**
  - 新会话（比如只发了 hello）显示空白 / 准备状态，不查询 hmz，也不自动显示或接管同目录里其它会话的 epic。
  - 启动后，列出本会话的 run（最新的是当前任务），选中的 run 展示 **Epic → Agent（角色）→ Session** 树和所选 Session 的输出（轮次、思考、消息、工具），可折叠，分页加载更早的内容。
  - 查看历史 run 不会改变 leader 的控制对象：发送、回答、停止始终作用于当前 run，页面上有提示。
- **任务归属以 DSH 会话 id 为准，不按工作目录判断。**
  - 一个会话可以顺序跑多个 run，历史只追加不覆盖。
  - 同一目录一次只能跑一个 flow；目录被其它任务占用时，启动会被拒绝并说明原因，不会带出那个任务的内容。
  - 不同目录可以并行。
- **生命周期：** hmz 在独立进程中持有 run。关闭页面或重启 DSH 都不会停止它，重新打开会话后恢复同一个 run。取消 leader 的回复不会停止 flow，停止 flow 需要显式调用 `hmz_flow_stop`。

## 会话范围限定（Flow 页的数据边界）

- Client 只发送 `sessionId` 和不透明的 `runId`（以及要查看的 Session key）。
- Host（`lib/runview.js`）只在**该会话自己的 run 记录**里解析出受信的 epic：
  - 别的会话的 runId、格式不合法的 id，在调用适配器之前就被拒绝（HTTP 403）；
  - 该 run 没有打开过的 Session key，在读取转录之前被拒绝（403）。判断 key 是否属于该 run 时，若 Host 还没有缓存这个 run 的树，会先读取一次**本 run 自己的** Epic→Agent→Session 树；
  - 没有 run 的会话直接得到空列表，不调用任何 hmz 接口。
- 适配器（`epic_tree` / `epic_session`）再做一层检查：epic 必须是该工作目录自己的 epic 目录（`Hmz(workspace).epics.under()` 下的直接子目录，可以用名字或绝对路径指定，拒绝路径穿越和符号链接越界），Session key 使用 SDK 的复合键 `<backend>:<id>`。
- 读取方式：
  - 树来自 `Epics.read / sessions`；
  - 输出来自 `Epics.transcripts`：按 epic 缓存，以 epic 内文件签名加 15 秒 TTL 判断是否重读（Session 日志可能存放在 epic 之外），同一 epic 不会并发读取；
  - 每页最多 60 条动作，单个字段最多 4000 字。
- Client 按会话挂载视图（以 `sessionId` 为 key）。每个请求都绑定发起时的 `runId|sessionKey`，迟到的响应直接丢弃；新的选择不会被旧请求的“进行中”状态挡住。
- **这是 UX 和任务归属上的隔离，不是多租户安全隔离。** 浏览器用户就是这台机器上 hmz 的同一个 owner，可以直接用 hmz CLI / web 查看所有 epic。
- 不需要 hmz web 服务，不使用 iframe。

## 写保护与控制的边界

- **保护范围：** 本会话的 run 处于 starting / running / stopping / unknown 时，本会话及其子代理只能调用白名单里的读取 / 沟通 / 控制工具（`lib/policy.js`），由 `ctx.tools.guard` 在真实 dispatch 时拒绝其它调用。
  - 由模型直接调用的 `run_code` 会被拒绝。
  - 选中 flow 之后，leader 改为原生工具呈现（`presentAs('native')`），从而在启动之前就保证启动和控制工具可以直接调用。
  - 从 `run_code` 内部调用的启动会被拒绝。
- **启动前检查：** 先挡住新的写入，再检查本会话树上仍在运行的子代理、后台作业和执行中的工具；只要有一项还在运行就拒绝启动，绝不终止别人的进程。
- **状态记录：**
  - 启动意图先持久化再发出请求。
  - 启动结果未知时进入 `unknown`，不重发，只按 requestId 只读对账。
  - hmz 已接受但本地记录写盘失败时，如实报告“已接受但未记录”，保护保持开启。
  - stop 被接受不等于已经结束：要等 host 不再持有该 run、并且 epic 记录显示不在运行，才算结束并解除保护。
- **控制目标：** 每个动作都携带精确的 run 身份（host pid、host 启动时间、run 号、epic）。问答时绑定展示问题那一刻的 run，run 已被替换就拒绝发送回答。

**限制（如实说明）：**
- 现有 hmz SDK 没有原子的 expected-run 前置条件。适配器在同一个 link 上先读后写来缩小竞态窗口，但**不能保证与独立的原生 hmz 客户端（hmz web / CLI）并发时不出竞态**。
- 保护只覆盖本 DSH 会话及其子代理，不约束外部编辑器、其它 DSH 会话或原生 hmz 客户端。

## hmz 兼容性说明

- 当前 hmz 的“无账号 dsh”凭据读取器只认识旧版平铺 YAML，会把新版 DSH `.credentials.yaml`（version / records / refs）报成 ValueError。所以请使用**显式 hmz 账号**（例如 `dsh@preview-deepseek/deepseek-flash`），账号通过 hmz 公开的 accounts 接口存放在 hmz home 中。
- hmz 缓存的静态模型列表可能落后于 DSH 实际可用的模型（例如列出 `deepseek-v4-flash`，而实际 ID 是 `deepseek-flash`）。所以选项面板的模型栏可以自由输入，列表只作候选。
- hmz 的 trace 可能不保存某些后端的工具输出，此时 Flow 页显示“hmz 记录中无输出”。

## 隔离预览

```bash
# 默认：.preview/，tmux socket dsh-hmz-preview（端口随机，或用 DSH_PORT 指定）
scripts/preview.sh start
# 查看：scripts/preview.sh status    停止：scripts/preview.sh stop
# 第二套并行预览：独立 DSH home、状态、tmux socket 和端口；复用第一套的 hmz 账号 home
PREVIEW_DIR=$PWD/.preview-test PREVIEW_TMUX=dsh-hmz-test DSH_PORT=44190 \
  PREVIEW_HMZ_HOME=$PWD/.preview/hmz-home PREVIEW_CREDENTIALS_FROM=$PWD/.preview/dsh-home \
  scripts/preview.sh start
```

- 不会动 `~/.dsh`、`~/.hmz`、全局 hmz daemon，也不会动原有的 tmux `dsh` / `hmz-web`。
- 带启动 token 的地址只写在 `$PREVIEW_DIR/private/dsh-url`（0600），不会打印出来。
- 凭据只做静默复制，并设为 0600。

## 插件配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-hmz-flow
  name: '@dsh-hmz/flow'
  config:
    python: /path/to/hmz-install/venv/bin/python     # 或 hmzBin: /path/to/hmz-install/bin/hmz
    stateDir: /path/to/plugin-state                   # 可选；默认 $DSH_PROFILE_DIR/hmz-flow-state
    hmzEnv: { HUMANIZE_HOME: ..., TMPDIR: ..., HUMANIZE_DSH_BIN: ... }   # 可选
    monitorMs: 4000                                   # 可选；运行中任务的观测间隔
```

插件状态是 `stateDir/state.json`（v3，0600，先写临时文件再原子替换；会自动从 v1/v2 迁移），内容包括每个会话的选择、选项、run 历史和当前 run。

## 测试

以下命令都在**仓库根目录**执行；hmz 安装路径含空格，所以 `"$PY"` 必须加引号。

```bash
(cd packages/dsh-hmz-flow && npm test)      # Node 行为测试：状态 / 迁移 / 范围限定 / 路由 / 控制器 / 策略 / 选项 / 消息 / 适配器客户端
PY="/root/artifacts/hmz-installed-dsh-20261104/test install/venv/bin/python"   # hmz 安装自带的 python
ADAPTER=packages/dsh-hmz-flow/adapter/hmz_adapter.py
"$PY" -I packages/dsh-hmz-flow/tests/adapter_start_unit.py "$ADAPTER"   # 启动绑定故障注入
"$PY" -I packages/dsh-hmz-flow/tests/adapter_epic_unit.py  "$ADAPTER"   # epic 名解析 / 越界 / 复合键 / 缓存 TTL
# 真实 SDK 只读读取已有 epic（不启动任何东西）
HUMANIZE_HOME=... TMPDIR=<私有 tmp> "$PY" -I tests/e2e/adapter_epic_read.py "$ADAPTER" <workspace> <epic名或路径> <另一目录的epic> '<names-json>'
# 真实 SDK 动作（会启动两个极小的 DeepSeek chat run；拒绝 Claude）
HUMANIZE_HOME=... TMPDIR=... HUMANIZE_DSH_BIN=... "$PY" -I tests/e2e/adapter_actions.py "$ADAPTER" <测试目录>
# 浏览器（Playwright；用带 playwright 的 python，并在 tests/e2e 目录里运行，因为脚本要导入同目录的 dshpage.py）
PW=/root/src/humanize-installed-dsh/.venv/bin/python
(cd tests/e2e && "$PW" plus_menu.py "$PWD/../../.preview-test")       # ＋ → Flow → 选择 / 取消，草稿保留，不启动
(cd tests/e2e && "$PW" view_race.py "$PWD/../../.preview-test")       # 真实 client.js + 模拟 RPC：切换 run / Session 时的迟到响应
(cd tests/e2e && "$PW" flow_rpc_real.py "$PWD/../../.preview-test")   # 真实 Host + 适配器 + SDK：本会话读取，跨会话 403
# 会启动真实 DeepSeek run，需 PREVIEW_TMUX=dsh-hmz-test DSH_PORT=44190 等专用测试预览
(cd tests/e2e && "$PW" verify_flow.py "$PWD/../../.preview-test" "$PWD/../../.preview-test/shots" chat)
(cd tests/e2e && "$PW" verify_sessions.py "$PWD/../../.preview-test" "$PWD/../../.preview-test/shots")
```

真实 flow 只使用 DeepSeek 账号（`HMZ_TEST_AGENT` / `HMZ_TEST_AGENT_PARTS`），测试脚本会拒绝 Claude。
