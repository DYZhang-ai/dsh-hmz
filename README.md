# DSH × hmz Flow 集成（外部插件 + 外置适配层）

外部 DSH 插件 `@dsh-hmz/flow`（`packages/dsh-hmz-flow`）：在 DSH 里选择 hmz flow，用户的任务在 hmz 里执行，DSH 入口 Agent 继续担任 leader / 秘书。

**hmz 和已安装 DSH 的源码都没有修改。** 插件只使用两类公开接口：
- DSH 公开插件接口：`tools.guard`、`agent/pre-step`、`agent.followup`、`connection.fetch`、`webServer`、`slots`、`inputTriggers`、`commandUi`、`userQuestions`、`llm.listModels`；
- hmz 公开 SDK：`hmz.sdk.Hmz`、`Daemons`、`Link`。

此外，Flow 页直接加载 hmz 安装自带的 Web 前端模块来渲染。

## 用户能做什么

1. **选择 flow**：点输入框左下角 **＋ → 指令 → Flow**，或者键入 `/` 在 **Flow** 分组里选。
   - 两个入口只做选择，不会启动任何东西。
   - 草稿保留，包括选中的文字。实现方式：选择成功后调用公开的 `commandUi.dismiss`，所以 popup 不会消费它打开时捕获的选区；只有当整个草稿就是键入的 `/flow` 时，才用公开的 bare-token 方式把它去掉。
2. **配置**：输入框底部的 **flow选项** 打开配置面板，内容由 hmz 的 flow 声明驱动：
   - 每个角色的 CLI / 账号 / 模型 / effort，预算，环境，params，profile 开关，“附带前文”开关（默认开启）。
   - **保存成功后面板自动收起**，再点 flow选项 可以重新打开，值都在；保存失败时面板保持打开并显示原因。
   - 保存后的选项是权威的：清空的字段不会从 hmz 的记忆里回填。
   - 当 CLI 是 `dsh` 时，模型候选来自当前 DSH 官方目录 `ctx.llm.listModels('deepseek-official')`，因为 hmz 自带的静态列表可能过时（例如 `deepseek-v4-flash`，而当前 DSH 的 id 是 `deepseek-flash`）。
     - 该角色模型为空时，默认填入这个目录的第一个模型。
     - 已保存的自定义模型不会被替换；如果它不在这个目录里，只给出一条提示。自定义 endpoint 的账号仍然可能可用这个模型。
3. **普通任务直接进入 flow**：选中 flow 并且本会话没有正在运行的任务时，用户发出的下一条普通消息会被确定性地启动为 flow 任务，不需要提 hmz 或工具名。
   - 实现：一个 `agent/pre-step` waterfall 监听器，在 leader 的这一步进入模型之前调用 `controller.start`，然后给 leader 附上一条 `[hmz flow notice]`（附带的是这条通知，不是用户指令）。
   - 只有真实用户消息（`source.kind` 为 `user` / `user-rpc`）才会触发；插件通知、问答回复、运行时上下文都不会。
   - 每条消息 id 先持久化，最多启动一次，重放或刷新都不会再次启动。
   - 只用新出现的消息组成任务；成功会清掉上一次的失败记录。
   - 在发出启动请求之前，会在多个检查点确认没有被取消：等完前一个 waterfall 之后、读完 flow 声明之后、进入 controller 的串行队列之后。被取消就不启动，并释放这些消息 id。
   - hmz 已经接受的任务，不会因为 leader 的回复被取消而停止。
   - 启动被拒绝或结果未知时，Flow 页和 leader 都能看到原因，并且**写操作在 flow 模式下仍然被拦截**，leader 不会自己把这个任务做掉（`hmz_flow_start` 只用于用户明确要求的重试）。
4. **运行中**：
   - 消息仍然发给 leader，由它通过 `hmz_flow_send` 按角色或 Agent 转达，不会为每条消息开一个新 run。
   - hmz 向人提的问题经 `hmz_flow_answer` 用 DSH 问答卡交给真实用户回答。
   - 问进度只做查询。
5. **停止 flow**：Flow 页顶栏和 flow选项 面板里都有 **停止 flow** 按钮，与停止 leader 回复是两件事。
   - 点击时带上该 run 的精确身份（host pid、host 启动时间、run 号、epic），Host 会和本会话当前的 run 核对；查看历史 run 时不会误停新的 run。
   - 停止请求被接受后显示“正在停止…”并禁止重复点击；只有观测确认已结束才显示 ended 并解除保护。
6. **取消 flow 模式**：＋ / `/` → Flow → 取消 flow 模式，回到普通 DSH。

## Flow 页：hmz 原生渲染，只显示本会话的任务

- **范围**：
  - 新会话没有任务时显示空白 / 准备状态，不调用 hmz，也不显示或接管同目录里其它会话的 epic。
  - 有任务后，页面上方是本会话的 run 列表（当前任务和历史任务），外加停止按钮；下方是 **hmz 自己的 epic 视图**：Graph/List、Agent 卡片、Session 线程、右侧 EPIC/ASIDE 面板。
- **复用边界**：
  - Host 提供前缀路由 `/hmzf-viewer/`，只提供两类静态文件：插件的 viewer 文件（`viewer/`），以及从**已安装 hmz** 读取的 epic 视图所需模块。后者是白名单：`views/epic.js` 及其依赖 `acting / api / composer / dom / epic / graph / held / shell / transcript / ui`，再加 `style.css / theme.js / mark.svg`。路由只接受规范路径。
  - hmz 的 `app.js`（全局工作台、侧栏、路由）和 `sidebar.js` 不会加载：import map 把它们换成两个很小的 shim（`viewer/shim/`）。
  - viewer 自己的路由只允许停留在这一个 run 内部（graph / agent / session）；新建 epic、搜索、设置、其它 run、Exomyth 都会被重定向回这个 run。
- **隔离**：
  - viewer 放在 `sandbox="allow-scripts"` 的 iframe 里，是不透明 origin：拿不到 DSH 的 cookie 和 localStorage。
  - CSP 设为 `connect-src 'none'`，viewer 自己连不上任何服务器。
  - 它发出的所有 API 读请求都通过 postMessage 交给 DSH 页面；DSH 页面只回答这个 run 的 `GET /api/runs/<epic>` 和 `/trace`，其它一律拒绝。
  - Host 用该会话自己的 runId 解析出 epic（`viewDetail` / `viewTrace`）。跨会话的 runId 被 403。数据由 hmz 自己的 `hmz.web.runs.detail / calls` 和 `Epics.transcripts` 构造。
- **隐藏的控件**（`viewer/viewer.css`）：在 DSH 里不可用的原生控件，包括消息框 / dock、Resume、Export、Upload、Exomyth、Copy link、侧栏开关。保留 Graph/List、卡片、Session，以及右侧面板的开关。
- **运行期日志刷新**：
  - 原生视图把 run 当作已写完的记录来读：每 4 秒轮询 detail，但 trace 只读一次，而且 detail 的 JSON 不变时轮询不会通知视图。
  - 因此在提供 `views/epic.js` 时打 **5 个精确文本补丁**（`lib/viewer-patches.js`，带 `[dsh-hmz-flow] live trace patch` 标记，响应头 `x-hmzf-patches`）：
    - 加一个独立的 4 秒定时器：在**本会话 binding 的真实 phase** 仍是 active 时重读 trace（这个 phase 由 Host 放进 `detail._dshFlow`；chat 等待用户时，即使最后一轮已 done，也仍算 active）；不再 active 后最后读一次，之后停止；
    - 只有 trace 内容真的变化时才增加修订号并重绘线程，并保留阅读位置（读者原本在末尾时跟随到末尾）；
    - 离开视图时清除定时器。
  - Graph 的缩放和选择不会被重置。进入同一个 run 内部的地址时用原生的 `moved()`，不重新挂载视图。
  - 补丁锚点和 hmz 版本不匹配时，整份文件原样提供（没有实时刷新）并记录日志。
  - 读取结果在 adapter 中按 epic 缓存（文件签名加 15 秒 TTL），不会每秒全量 trace。
- **说明**：这是任务归属和 UX 上的隔离，不是多租户安全隔离；这台机器上 hmz 的 owner 可以直接用 hmz CLI 或 web 看到所有 epic。

## 写保护、生命周期与限制

- **写保护的两层**：
  - **flow 模式**（已选 flow、没有活跃 run）：本会话及其子代理只能调用读取 / 沟通 / 控制类工具，外加 `hmz_flow_start`。
  - **活跃 run 期间**（starting / running / stopping / unknown）：只能调用读取 / 沟通 / 控制类工具。
  - 两层都由 `ctx.tools.guard` 在真实 dispatch 时执行，使用白名单（`lib/policy.js`）。
  - 选中 flow 后，leader 的工具改为原生呈现（`presentAs('native')`）。模型直接调用的 `run_code` 会被拒绝；从 `run_code` 内部调用启动也会被拒绝。
- **启动前检查**：先挡住新的写入，再检查本会话树上仍在运行的子代理、后台作业和执行中的工具（只排除当前这次调用）；有任何一项在运行就拒绝启动，不终止任何东西。
- **启动和停止的记录**：
  - 启动意图先持久化再发出。结果未知时进入 `unknown`，不重发，只按 requestId 只读对账。
  - hmz 已接受、但本地写盘失败时，如实报告“已接受但未记录”。
  - stop 被接受只代表进入 stopping；要等 host 不再持有该 run、并且 epic 记录显示不在运行，才算 ended。
- **任务归属**：以 DSH 会话 id 为准，不按工作目录判断。一个会话的 run 历史只追加不覆盖，最多一个当前 run；控制目标始终是当前 run。
- **目录**：同一目录一次只能跑一个 flow，不同目录可以并行。
- **生命周期**：hmz 在独立进程中运行任务。关闭页面或重启 DSH 都会接回同一个 run。取消 leader 的回复不会停止 flow。
- **限制**：
  - hmz SDK 没有原子的 expected-run 前置条件：适配器在同一个 link 上先读后写来缩小竞态窗口，但**不能保证与独立的原生 hmz 客户端（hmz web / CLI）并发时不出竞态**。
  - 写保护只覆盖本 DSH 会话及其子代理。

## hmz 兼容性

- hmz 的无账号 dsh 凭据读取器只认识旧版平铺 YAML，不认识 DSH 新版 `.credentials.yaml`。所以请使用显式 hmz 账号，例如 `dsh@preview-deepseek/deepseek-flash`。
- 原生 viewer 依赖已安装 hmz 的前端模块结构。白名单和 5 个补丁锚点对应当前安装的 hmz 0.2.2；版本变化时补丁会整体跳过，此时 viewer 仍能显示，只是没有实时线程刷新。

## 预览（隔离，不动用户服务）

```bash
scripts/preview.sh start
# 查看：scripts/preview.sh status    停止：scripts/preview.sh stop
# 第二套并行预览（独立 DSH home、状态、tmux socket 和端口；复用第一套的 hmz 账号 home）
PREVIEW_DIR=$PWD/.preview-test PREVIEW_TMUX=dsh-hmz-test DSH_PORT=44190 \
  PREVIEW_HMZ_HOME=$PWD/.preview/hmz-home PREVIEW_CREDENTIALS_FROM=$PWD/.preview/dsh-home \
  scripts/preview.sh start
```

带启动 token 的地址只写在 `$PREVIEW_DIR/private/dsh-url`（0600）。插件配置写在 profile 的 `cordis.patch.yml` 里：`python` 或 `hmzBin`，可选的 `stateDir`、`hmzEnv`（`HUMANIZE_HOME` / `TMPDIR` / `HUMANIZE_DSH_BIN`）、`monitorMs`、`dshProvider`（默认 `deepseek-official`）。

## 测试（在仓库根目录执行；hmz 的 python 路径含空格，请加引号）

```bash
(cd packages/dsh-hmz-flow && npm test)          # 58 个 Node 行为测试
PY="/root/artifacts/hmz-installed-dsh-20261104/test install/venv/bin/python"
ADAPTER=packages/dsh-hmz-flow/adapter/hmz_adapter.py
"$PY" -I packages/dsh-hmz-flow/tests/adapter_start_unit.py "$ADAPTER"
"$PY" -I packages/dsh-hmz-flow/tests/adapter_epic_unit.py  "$ADAPTER"
(cd packages/dsh-hmz-flow && npm pack --dry-run)  # 检查 viewer/*.js、viewer/*.css、viewer/shim/*.js 都在包里
# 浏览器（Playwright；在 tests/e2e 里运行，用带 playwright 的 python）
PW=/root/src/humanize-installed-dsh/.venv/bin/python
(cd tests/e2e && "$PW" plus_menu.py "$PWD/../../.preview-test")
(cd tests/e2e && "$PW" flow_rpc_real.py "$PWD/../../.preview-test")
# 原生 viewer 夹具：detail 固定、trace 新增消息；用 adapter 的 web_detail / web_trace 导出一个真实 epic 的 JSON 作为输入
(cd tests/e2e && "$PW" viewer_live_fixture.py 44190 /tmp/detail.json /tmp/trace.json)
# 真实 DeepSeek 任务（会运行模型；拒绝 Claude）：tests/e2e/adapter_actions.py、tests/e2e/verify_flow.py
```

Node 测试覆盖：
- 状态与迁移；会话范围限定 / 路由 403；控制器；策略；选项；消息；适配器客户端；
- 自动启动：只用新消息、来源过滤、取消、拒绝后写保护、成功后清除错误；
- 停止身份校验；viewer 路由白名单与 CSP；补丁能应用到已安装的 hmz，版本不匹配时整体跳过。

**主审独立验收证据**（`/root/src/dsh-hmz/work-review/20261105/`）：

| 证据文件 | 内容 |
|---|---|
| `review-ordinary-native-result.json` | 真实 DeepSeek rlar：普通任务自动启动且只有 1 个 run；原生 Graph 和右侧面板正常，没有全局侧栏 |
| `review-stop-real-result.json` | 真实 chat：停止 → stopping → SDK 确认 ended |
| `review-native-fixture-result.json` | detail 固定、trace 新增消息时实时出现；不再 active 后停止读取；原生输入框已隐藏 |
| `review-native-scope-result.json` | 跨会话的 viewDetail / viewTrace / stop 都被 403；`_dshFlow` 取自 binding；重启后是同一个 run |
| `review-save-close-result.json` | 保存成功收起、失败保持 |
| `review-plus-menu-result.json` | ＋ 菜单草稿和选中文字都保留 |
