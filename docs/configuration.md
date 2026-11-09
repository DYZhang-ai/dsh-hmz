# 配置与运行指南

本文档说明 `@dsh-hmz/flow` 的插件配置参数、隔离预览脚本 `scripts/preview.sh` 的环境变量与目录结构、凭据与账号设置，以及使用过程中的关键运行规则。

---

## 1. 环境与安装布局要求

集成不修改已安装的 DSH 与 `hmz` 源码，但依赖两者在本地的已安装环境：

- **DSH**：已安装的 DSH 启动器（可执行文件，支持 `--profile` 与 Web 模式）。
- **hmz 独立安装布局（standalone-install layout）**：
  - `scripts/preview.sh` 以及插件配置中的 `hmzBin` 推导逻辑，均假定 `hmz` 采用包含独立虚拟环境的目录结构：
    ```text
    <hmz-root>/
    ├── bin/hmz
    ├── venv/bin/python
    └── share/dsh-path   # 可选，hmz 的 dsh 后端可执行文件路径记录
    ```
  - **注意**：并非任意全局 `pip install` 生成的单文件启动器都满足此目录约定。如果你的 `hmz` 安装不在此布局下，在正式配置插件时请直接指定 `config.python`（指向安装了 `hmz` 包的 Python 解释器绝对路径），而不要依赖从 `hmzBin` 自动推导 `../venv/bin/python`。
- **预览脚本额外依赖**：`bash`、`git`、`tmux`。

---

## 2. 插件配置（`cordis.patch.yml`）

`@dsh-hmz/flow` 作为 DSH bundle 加载时，包内的 [`packages/dsh-hmz-flow/cordis.patch.yml`](../packages/dsh-hmz-flow/cordis.patch.yml) 仅插入空的插件声明。机器相关的路径与环境配置应在对应 DSH profile 的 `cordis.patch.yml`（或启动时的 `--patch` 覆盖层）中提供：

```yaml
- id: dsh-hmz-flow
  name: '@dsh-hmz/flow'
  config:
    python: '/abs/path/to/hmz-root/venv/bin/python'
    stateDir: '/abs/path/to/state-dir'
    hmzEnv:
      HUMANIZE_HOME: '/abs/path/to/hmz-home'
      TMPDIR: '/abs/path/to/hmz-tmp'
      HUMANIZE_DSH_BIN: '/abs/path/to/dsh'
```

### 配置项参考

| 字段 | 类型 | 必填 / 默认值 | 说明 |
|---|---|---|---|
| `python` | `string` | 与 `hmzBin` 二选一 | 安装了 `hmz` SDK 的 Python 解释器绝对路径。优先级高于环境变量 `DSH_HMZ_PYTHON` 和 `hmzBin`。 |
| `hmzBin` | `string` | 与 `python` 二选一 | `hmz` 启动器路径（或通过环境变量 `DSH_HMZ_BIN` 提供）。从 `<hmz-root>/bin/hmz` 推导出 `<hmz-root>/venv/bin/python`。 |
| `stateDir` | `string` | 可选 | 插件持久化状态目录（存放 `state.json`）。默认依次取 `$DSH_PROFILE_DIR/hmz-flow-state` 或 `~/.dsh-hmz-flow`。 |
| `hmzEnv` | `object` | `{}` | 传给 Python 适配层子进程的附加环境变量。常用键：<br>• `HUMANIZE_HOME`：指定 `hmz` 的主目录（账号、epic 记录等）<br>• `TMPDIR`：指定 `hmz` daemon socket 所在的临时目录<br>• `HUMANIZE_DSH_BIN`：供 `hmz` 的 `dsh` 后端调用的 DSH 可执行文件路径 |
| `dshProvider` | `string` | `'deepseek-official'` | 当角色 CLI 选为 `dsh` 时，向 `ctx.llm.listModels(provider)` 查询候选模型列表所用的 provider 名称。 |
| `monitorMs` | `number` | `4000` | 后台轮询活跃 run 状态与待处理问题的时间间隔（毫秒）。 |
| `adapterTimeoutMs` | `number` | `60000` | 适配层常规请求默认超时时间（毫秒）；`start` 请求固定使用 200,000 毫秒超时。 |
| `observerTickMs` | `number` | `5000` | 流程提醒（旁路观察）调度器的轮询间隔（毫秒）。 |
| `observer` | `object` | 见下 | 可选，覆盖流程提醒默认参数（如 `intervalMs: 30000`、`maxAttempts: 6`、`timeoutMs: 45000`、`maxTokens: 900`）。 |

---

## 3. 使用 `scripts/preview.sh` 启动隔离预览

[`scripts/preview.sh`](../scripts/preview.sh) 用于在不触碰用户全局 `~/.dsh`、`~/.hmz` 及全局 `hmz` daemon 的前提下，启动一套挂载了 `@dsh-hmz/flow` 的隔离 DSH Web 服务。

> **重要**：脚本内 `DSH_BIN` 与 `HMZ_BIN` 的默认值仅对应原始开发机的本地目录。在其他机器上运行时，**必须显式传入本机的绝对路径**。

### 环境变量一览

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `DSH_BIN` | 开发机内部路径（必须覆盖） | 已安装的 `dsh` 启动器绝对路径。 |
| `HMZ_BIN` | 开发机内部路径（必须覆盖） | 已安装的 `hmz` 启动器绝对路径。脚本会检查其旁边的 `../venv/bin/python` 是否可执行。 |
| `PREVIEW_DIR` | `<repo>/.preview` | 预览环境的根目录，存放隔离的 `dsh-home`、`hmz-home`、`tmp`、`state`、`logs`、`demo` 和 `private`。 |
| `PREVIEW_TMUX` | `dsh-hmz-preview` | 独立 `tmux -L` socket 名称，与用户日常 tmux 会话隔离。 |
| `PREVIEW_PROFILE` | `hmzflow` | 在隔离 `dsh-home/profiles/` 下生成的 DSH profile 名称。 |
| `DSH_PORT` | `0`（自动分配空闲端口） | DSH Web 监听端口（仅绑定 `127.0.0.1`）。 |
| `PREVIEW_CREDENTIALS_FROM` | 空 | 可选。指向某个已配置好凭据的 DSH home 目录；若当前预览的 `dsh-home/.credentials.yaml` 尚不存在，脚本会以 `0600` 权限将其复制过来。 |
| `PREVIEW_HMZ_HOME` | `$PREVIEW_DIR/hmz-home` | 可选。指定使用的 `HUMANIZE_HOME`。设为已有的 `hmz` 主目录可复用其中的 `hmz` 账号配置，但需注意这会改变账号与 epic 存储的隔离边界（daemon socket 仍由各自的 `$PREVIEW_DIR/tmp` 隔离）。 |

### 准备与启动步骤

**第一步：准备预览目录与配置**

```bash
export DSH_BIN="/abs/path/to/dsh"
export HMZ_BIN="/abs/path/to/hmz-root/bin/hmz"
PREVIEW_CREDENTIALS_FROM="$HOME/.dsh" \
  scripts/preview.sh prepare
```

预览使用以下目录结构（默认位于 `.preview/`；`prepare` 创建基础目录，状态与日志在运行时写入）：

- `dsh-home/`：隔离的 `DSH_HOME`，内含 `profiles/hmzflow/`，并通过符号链接挂载本仓库的 `packages/dsh-hmz-flow`
- `hmz-home/`：隔离的 `HUMANIZE_HOME`（若未指定 `PREVIEW_HMZ_HOME`）
- `tmp/`：隔离的 `TMPDIR`（权限 `0700`），使预览内的 `hmz` daemon socket 独立于系统全局环境
- `state/`：插件状态存储目录（`state.json`）
- `demo/`：自动初始化的示例 Git 仓库，作为默认启动工作区
- `logs/`：`dsh.out` 与 `dsh.err`
- `private/`：权限 `0700`，启动后写入带访问 token 的 URL 文件 `private/dsh-url`（权限 `0600`）

**第二步：检查凭据与 `hmz` 账号**

由于预览环境默认拥有空的 `dsh-home` 和 `hmz-home`，在启动真实模型任务前需确保两处凭据可用：

1. **DSH 秘书模型凭据**：
   - 若已在 `prepare` / `start` 时设置 `PREVIEW_CREDENTIALS_FROM="$HOME/.dsh"`，脚本会自动复制 `.credentials.yaml`（仅当预览目录尚无该文件时）。
   - 否则，需在启动预览后在 DSH Web 界面中完成模型登录或配置。
2. **hmz 执行角色账号（重要）**：
   - **为什么需要显式账号**：`hmz` 内置的无账号（Local）`dsh` 凭据读取器只兼容旧版平铺式 YAML，无法解析新版 DSH 的 `.credentials.yaml` 格式。
   - 因此，当 flow 角色使用 `dsh` 作为 CLI 后端时，**必须在 `hmz` 中配置并使用显式账号**（例如在 `flow选项` 中选择账号 `preview-deepseek`，组合成 `dsh@preview-deepseek/deepseek-flash`）。
   - 配置方式：
     - 在隔离的 `hmz-home` 中打开 hmz 终端界面：
       ```bash
       HUMANIZE_HOME="$PWD/.preview/hmz-home" \
       TMPDIR="$PWD/.preview/tmp" \
         "$HMZ_BIN"
       ```
       在界面中输入 `/settings accounts`，添加 `dsh` 账号，按提示配置凭据，保存后退出。后续在 `flow选项` 中选择这个账号。
     - 或在准备和启动预览前设置 `export PREVIEW_HMZ_HOME="$HOME/.hmz"`，复用已配置好显式账号的 `hmz` 主目录。

**第三步：启动、查看状态与停止**

```bash
# 启动（在独立 tmux 服务中后台运行 DSH Web）
scripts/preview.sh start

# 查看 tmux 会话与 URL 文件路径
scripts/preview.sh status

# 停止预览的 DSH Web 会话
scripts/preview.sh stop
```

- 启动成功后，脚本终端摘要不打印带 token 的完整 URL；地址保存在 `$PREVIEW_DIR/private/dsh-url`（`0600`），DSH 原始输出 `logs/dsh.out` 中也包含它。请在本地读取地址，不要公开 URL 或未经处理的日志。
- 执行 `scripts/preview.sh stop` 只会关闭预览的 DSH tmux 会话；**由 flow 启动的 `hmz` daemon host 进程按设计会继续在后台运行**。

### 并行运行多套预览

使用自定义 `PREVIEW_DIR`、`PREVIEW_TMUX` 或 `PREVIEW_HMZ_HOME` 时，请在 `prepare`、账号配置、`start`、`status`、`stop` 各步骤中保持同一组设置；可先用 `export` 保存到当前 shell。

通过指定不同的 `PREVIEW_DIR`、`PREVIEW_TMUX` 和 `DSH_PORT`，可以在同一台机器上并行运行多套互不干扰的预览（各自拥有独立的 `TMPDIR` 和 daemon socket，可按需通过 `PREVIEW_HMZ_HOME` 共享第一套的账号配置）：

```bash
DSH_BIN="/abs/path/to/dsh" \
HMZ_BIN="/abs/path/to/hmz-root/bin/hmz" \
PREVIEW_DIR="$PWD/.preview-2" \
PREVIEW_TMUX=dsh-hmz-preview-2 \
DSH_PORT=44190 \
PREVIEW_HMZ_HOME="$PWD/.preview/hmz-home" \
PREVIEW_CREDENTIALS_FROM="$PWD/.preview/dsh-home" \
  scripts/preview.sh start
```

---

## 4. Flow 选项与日常操作规则

### 4.1 选择与配置 Flow

1. **选择入口**：点击输入框左下角 **＋ → 指令 → Flow**，或在输入框首位键入 `/` 并在 **Flow** 分组中选择。
   - **仅做选择，绝不自动启动**：选择动作只记录当前会话可选用的 flow，不会触发任务启动，也不会开启写保护。
   - **草稿与选区保留**：通过公开的 `commandUi.dismiss` 关闭弹窗，编辑器内已输入的草稿与选中文本均保持原样；仅当整个草稿恰好是输入的 `/flow` 前缀 token 时，才会将其清除。
2. **`flow选项` 面板**：
   - 选中 flow 后，输入框左下方出现 `flow选项 · <flow名>` 按钮，点击可展开配置面板。
   - 可配置项由 `hmz` 对该 flow 的声明动态生成：
     - **AGENTS**：各非自动角色的 `CLI`、`ACCOUNT`、`MODEL`、`EFFORT`
     - **BUDGET**：费用上限（`COST, $`）、时间上限（`TIME, MIN`）、输出 Token 上限（`OUTPUT TOKENS`）及各自的 `graceful` 开关。**除 `chat` 外的 flow 至少需要设置一项预算限制。**
     - **ENVIRONMENTS** / **PARAMS (JSON)** / **Profile 开关**（按 flow 声明显示）
     - **附带前文**（默认开启）：启动时将本会话可见的用户/助手消息快照（最多 40 条、单条上限 2,000 字、总计上限 12,000 字；**不含**系统提示词、注入上下文、思考过程与原始工具日志）作为背景附在任务后。
   - **保存行为与权威性**：
     - 点击 **保存** 成功后，面板自动收起；再次点击 `flow选项` 可重新打开并查看已保存的值。若校验或保存失败，面板保持打开并显示具体原因。
     - 一旦在 DSH 中保存过选项，该配置即为**权威配置**（启动时冻结）：用户主动清空的预算、参数或环境字段会保持清空，**不会**从 `hmz` 工作区历史记忆（`remembered`）中自动回填。
3. **DSH 模型目录同步（当角色 CLI 为 `dsh` 时）**：
   - `hmz` 自带的静态模型列表可能滞后于当前安装的 DSH（例如旧列表包含已弃用的模型 ID，而当前 DSH 官方目录为 `deepseek-flash`）。
   - 当角色的 CLI 设为 `dsh` 时，插件会通过 `ctx.llm.listModels(dshProvider)` 获取当前 DSH 的实时模型目录作为候选项；若模型字段为空，会自动填入该目录的第一个模型。
   - 模型输入框支持自由键入。若已保存的模型不在当前 DSH 官方目录中，插件**不会篡改或替换**用户的输入，仅在面板中显示一条提示（使用自定义 endpoint 的账号仍可能支持该模型）。

### 4.2 秘书（Leader）调度与运行期交互

- **先经秘书判断**：选中 flow 后，你发送的每条消息依然先交给 DSH 入口智能体（秘书）。
  - 讨论、方案咨询、代码解释：秘书直接回答或读取文件。
  - 适合交给所选 flow 执行的任务：秘书直接调用 `hmz_flow_start` 启动（无需二次弹窗确认）。
  - 目标或接收对象确实不明确：秘书先简短追问澄清。
- **运行期写保护**：
  - 当本会话的 run 处于 `starting`、`running`、`stopping` 或 `unknown`（以及启动前检查 fence 期间）时，本会话及其子代理受 `ctx.tools.guard` 白名单保护，只能调用只读、搜索、提问及 flow 控制工具；文件写入、Shell 执行、子代理派生和模型直接调用的 `run_code` 均被拒绝。
- **运行期沟通**：
  - 询问进度：秘书调用 `hmz_flow_status` 查询并回答，不会向 flow 转发。
  - 补充要求或修正指令：秘书通过 `hmz_flow_send` 明确指定目标角色（`role`）或智能体 ID（`agent`）发送，绝不发送空目标，也不会把所有闲聊机械转发给 flow。
  - 回答 flow 的提问：当 `hmz` 中的角色向人类提问时，秘书收到通知后调用 `hmz_flow_answer`，由 DSH 原生问答卡片向真实用户展示问题并收集回答，秘书绝不自行代答。
- **停止任务 vs 停止回复**：
  - 点击 DSH 输入框的停止按钮只会中断秘书当前的回复生成；一旦 `hmz` 已接受任务，**取消秘书回复不会停止后台运行的 flow**。
  - 若要停止 flow，请点击 **Flow 页顶栏**或 **`flow选项` 面板**中的 **停止 flow** 按钮，或直接让秘书停止。停止请求被接受后状态变为 `stopping`（按钮变为“正在停止…”并禁用），直到后台进程释放且 epic 记录确认结束后才进入 `ended` 并解除写保护。

### 4.3 流程提醒（旁路观察）与费用说明

- **功能定位**：flow 运行期间，插件后台独立定时器会按需抽样检查当前 run 的可见工作记录（工作者消息、工具输入/输出/报错标记、各会话最近收到的指令），仅在发现**值得知道（`know`）**的设计取舍/风险，或有明确记录支撑的**请注意（`heads_up`）**执行问题（如反复报错、结果与最新指令不符）时，在输入框上方展示一张简短提醒卡片。
- **纯粹旁路**：只展示给用户看，绝不向 flow 或秘书发消息，也不调用任何工具或干预任务。
- **开关与状态**：在 `flow选项` 面板中可随时开启或关闭 **流程提醒**（默认开启），也可直接在提醒卡片上点击“关闭提醒”。开关下方实时显示当前状态与本任务已检查次数（`n/6`）。
- **调用上限与计费**：
  - 同一 run 两次检查至少间隔 30 秒；有未处理的打开提醒、记录未变化或无可用模型时不调用模型。
  - **每个任务（run）最多调用 6 次模型**（失败也计入，且在调用前持久化计数，DSH 重启不会重复消耗）。
  - 模型调用通过 DSH 的 `ctx.llm.stream` 使用**当前秘书的 provider 与 model**（无工具、无会话上下文，`maxTokens: 900`），**其费用独立计算，不计入 `hmz` 任务的预算（BUDGET）中**。

### 4.4 异常处理：启动结果未知（`unknown`）

- 插件在向 `hmz` 发送 `start` 请求前会先将启动意图（含唯一 `requestId`）持久化到 `state.json`。
- 如果请求发出后因超时、管道断开或 DSH Host 重启而未收到明确响应，该 run 会进入 **`unknown`（结果未知）**状态：
  - **绝不自动重发**：为避免重复启动任务，适配层与控制器绝不会自动重试 `start`。
  - **保持写保护**：在确认状态前保持会话写保护，防止冲突写入。
  - **只读对账**：后续后台轮询或调用 `hmz_flow_status` 时，会通过 `find_request` 按 `requestId` 进行只读核对；若发现 `hmz` 实际已启动该任务，会自动绑定回 `running` 状态。
  - **手动解除保护**：只有当你已确认 `hmz` 并未运行该任务，且只读对账仍无法绑定时，才应在 `flow选项` 面板中点击 **解除保护**（仅限用户在界面操作，秘书无此工具）。
