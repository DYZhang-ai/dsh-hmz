# DSH × hmz Flow 集成（外部插件 + 外置适配层）

本仓库提供一个 DSH 外部插件包 `@dsh-hmz/flow`（`packages/dsh-hmz-flow`），以及隔离预览脚本和测试。
**hmz 源码、已安装 DSH 本体均零修改**；集成只用 DSH 公开插件接口和 hmz 公开 SDK / 原生 Web。

> 当前为第一个纵向里程碑：菜单/选项/Flow 视图/只读查询已在真实 DSH 中接通；
> **flow 的启动、定向发送、回答问题、停止，以及写入保护尚未实现**（见“已知限制”）。

## 组成

| 部分 | 文件 | 作用 |
|---|---|---|
| Host 插件 | `packages/dsh-hmz-flow/index.js` | 注册 DSH 鉴权的 `POST /api/hmz-flow/rpc` 路由、只读 leader 工具 `hmz_flow_list`/`hmz_flow_status`、所选 flow 的 leader 动态上下文；启动嵌入代理 |
| Client 插件 | `packages/dsh-hmz-flow/client.js` | `/` 菜单中的 **Flow** 分组；输入框底部“**flow选项**”按钮；输入框上方 Flow 选项面板（附带前文开关等）；与“对话/轨迹”同级的 **Flow** 视图（iframe 原生 hmz） |
| Python 适配器 | `packages/dsh-hmz-flow/adapter/hmz_adapter.py` | stdio JSON 行协议，经 hmz 公开 SDK 提供 `ping/flows/flow/status`，只读；不启动 daemon host、不发控制请求 |
| 嵌入代理 | `packages/dsh-hmz-flow/lib/proxy.js` | 独立 loopback 端口反代 `hmz web`；见下文安全模型 |
| 插件状态 | `packages/dsh-hmz-flow/lib/state.js` | 插件自己的 `state.json`（0600，原子写）：每个 DSH 会话的 flow 选择与附带前文开关 |

## 隔离预览（不影响现有 tmux `dsh` / `hmz-web` 与 `~/.dsh`、`~/.hmz`）

```bash
scripts/preview.sh start     # 启动隔离 hmz web + 隔离 DSH（独立 tmux socket: dsh-hmz-preview）
scripts/preview.sh status
scripts/preview.sh stop      # 只停预览会话；flow 所在 hmz host 进程按设计继续存活
```

可用环境变量覆盖：`DSH_BIN`（已安装 dsh 启动器）、`HMZ_BIN`（已安装 hmz 启动器，旁边的 `venv/bin/python` 用于适配器）、
`PREVIEW_DIR`（默认 `.preview/`）、`DSH_PORT`（默认随机）。

脚本做的事：
- 在 `$PREVIEW_DIR/dsh-home` 建独立 `DSH_HOME` 与 profile `hmzflow`（bundles = dsh-base + dsh-web-app + `@dsh-hmz/flow`），
  `node_modules/@dsh-hmz/flow` 软链到本仓库包；机器相关配置只写入该 profile 的 `cordis.patch.yml`。
- `hmz web` 使用独立 `HUMANIZE_HOME` 与 `TMPDIR`（因而是独立的 hmz daemon socket）。其带 key 的地址只写入 `$PREVIEW_DIR/private/hmz-web-url`（0600），不进 git、不进浏览器。
- DSH 访问地址（含一次性启动 token）写在 `$PREVIEW_DIR/private/dsh-url`。用浏览器打开它，选择工作区 `$PREVIEW_DIR/demo`。

## 使用

1. 在输入框键入 `/`（或点 `+`），菜单中“添加”“指令”之后出现 **Flow** 分组，列出当前工作目录 hmz 可用 flow。
2. 选中某个 flow：`/` 记号被消费（不会作为消息发送），输入框底部出现“**flow选项 · <flow>**”，上方展开 Flow 选项面板。
   - 面板可切换 flow、切换“**附带前文**”（默认 ON，可关），选择即时持久化（刷新/重启 DSH 后仍在）。
   - 面板只读显示 hmz 声明的角色与可用 CLI；角色 CLI/账号/模型/effort、预算编辑**下一轮实现**。
   - 选中状态持续，直到在面板点“取消 flow 模式”或 `/` 菜单选“取消 flow 模式”。
3. 普通消息照常发给 DSH 入口 Agent（leader）。选中 flow 后，leader 通过动态上下文得知所选 flow，并可调用
   `hmz_flow_list`、`hmz_flow_status`（真实 hmz 查询）。询问进度只会查询。
4. 顶部“对话 / 轨迹 / **Flow**”：Flow 视图 iframe 嵌入原生 hmz Web（Epic→Agent→Session）。若当前目录有运行中的 run，自动深链到其 epic；
   否则显示 hmz 首页（不会把同目录的历史/他人 epic 自动当作本会话任务）。

## 嵌入代理安全模型

- 只监听 `127.0.0.1`；`Host` 必须是 loopback 名 + 代理端口（防 DNS rebinding），`Sec-Fetch-Site: cross-site` 拒绝。
- 浏览器进入代理只能凭 **一次性、60 秒有效** 的 ticket；ticket 只由 DSH Host 在 **DSH 已鉴权（owner）** 的 RPC 中签发。
  兑换后获得代理自身的 `HttpOnly; SameSite=Strict` 会话 cookie。无会话的任何请求均 401，且不会转发到 hmz。
- 代理在服务端用 hmz 的 key 登录并持有 hmz cookie；**hmz key 与 hmz cookie 都不下发给浏览器**，hmz 的 `Set-Cookie` 不透传。
- 只改两处响应头：去掉 `X-Frame-Options: DENY`；CSP 仅把 `frame-ancestors` 改为 DSH 页面 origin。其余 CSP 不变。
- 默认 **只读**：所有非 GET/HEAD 请求被拒（403），嵌入的 hmz 页面不能绕过 DSH leader 启动/发送/停止。可用插件配置 `embedReadOnly: false` 放开（此时写请求还须 `Origin` 为代理自身 origin）。
- hmz 自身的 key/cookie/同源检查仍然生效（代理只把自身 origin 改写为上游 origin）。

## 插件配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-hmz-flow
  name: '@dsh-hmz/flow'
  config:
    python: /path/to/hmz-install/venv/bin/python   # 或 hmzBin: /path/to/hmz-install/bin/hmz
    hmzWebUrlFile: /private/file/with/hmz-web-address   # `hmz web` 打印的带 key 地址所在文件（0600）
    stateDir: /path/to/plugin-state                     # 可选；默认 $DSH_PROFILE_DIR/hmz-flow-state
    hmzEnv: { HUMANIZE_HOME: ..., TMPDIR: ... }         # 可选；适配器环境（隔离用）
    embedReadOnly: true                                 # 默认 true
    frameAncestors: []                                  # 可选；额外允许嵌入的 DSH origin
```

在正式 profile 中安装：在 DSH 中用 `plugin_manager` 的 `install_bundle`，`target` 为本包绝对路径；再在该 profile 的补丁层写上面的 config。
（本轮只在隔离 profile 中验证过手工软链方式。）

## 测试

```bash
cd packages/dsh-hmz-flow && npm test                      # 19 个 Node 行为测试（代理鉴权/只读/ticket、状态持久化、适配器 unknown 语义）
# 真实 hmz 适配器冒烟（hmz 安装的 python，隔离 home）
HUMANIZE_HOME=.preview/hmz-home TMPDIR=.preview/tmp <hmz-python> -I tests/e2e/adapter_smoke.py \
  packages/dsh-hmz-flow/adapter/hmz_adapter.py $PWD/.preview/demo [demo-epic]
# 真实 DSH 预览的 HTTP 探针
tests/e2e/probe_live.sh <dsh-port> <proxy-port>
# 真实 DSH 预览的浏览器端到端（Playwright）
cd tests/e2e && <python-with-playwright> verify_ui.py ../../.preview/private/dsh-url ../../.preview/shots \
  $PWD/../../.preview/demo <demo-epic>
```

`tests/fixtures/make_demo_epic.py` 是测试夹具（不属于插件）：在隔离 hmz home 中用 SDK 跑一个极小的 `chat` flow 再停止，产生真实 epic。

## 已知限制 / 未完成

- 未实现：`hmz_flow_start`（含前文快照与长度策略）、按角色定向发送、转交 hmz 人类问题给真实用户、停止 flow、关键事件通知。
- 未实现：flow 执行期间对 leader 的写入保护（tools.guard/restrict、PTC/子任务/后台作业检查）。在此之前 leader 的写工具不受本插件约束。
- 现有 hmz SDK 的 `say/answer/stop` 没有 expected-run 原子条件；后续即使实现，也只能做“读后写”检查，不能宣称无竞态。
- 选项面板中角色 CLI/账号/模型/effort 与预算尚为只读显示。
- Flow 视图的深链仅针对“当前运行中”的 run；本会话与 epic 的显式绑定（持久 run 引用）尚未实现。
- 嵌入为只读；需要在 hmz 原生界面操作时，请直接打开 hmz web。
- Client 插件为手写 JS，样式只依赖 `--dsw-alias-*` 主题 token；未做多语言以外的可访问性审查。
