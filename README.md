# dsh-hmz

**在 DSH 中启动、查看和控制 hmz 多智能体流程。**

`dsh-hmz` 是连接 **DSH**（对话交互界面）与 **hmz / humanize**（多智能体流程执行引擎）的外部插件集成（[`packages/dsh-hmz-flow`](./packages/dsh-hmz-flow)）。在这套分工中，DSH 入口智能体担任你的“秘书”，负责日常讨论、判断何时启动流程、向后台角色转达修正要求，以及把流程中的真实提问交由你本人回答；复杂的多角色任务则在独立的 `hmz` 后台环境中执行。整个集成无需修改已安装的 DSH 或 `hmz` 源码。

```text
用户  <-->  DSH 秘书（探讨方案 / 按需启动 / 转达修正 / 问答桥接）  <-->  hmz 引擎（独立后台多角色执行）
```

| 文档 | 内容概览 |
| :--- | :--- |
| [配置与运行指南 (`docs/configuration.md`)](./docs/configuration.md) | 插件配置项、预览环境变量、凭据与显式账号设置、日常运行操作 |
| [架构与设计边界 (`docs/architecture.md`)](./docs/architecture.md) | 跨进程协作架构、会话归属模型、运行期写保护、任务视图与旁路观察设计 |
| [开发与测试指南 (`docs/development.md`)](./docs/development.md) | 目录结构、行为测试、Python 适配层测试、浏览器端到端验证与贡献指南 |

## 主要功能

- **秘书统筹，先讨论后执行**：在菜单中选择流程仅设定上下文，不会自动启动任务。你可以先与秘书推敲方案，在 `flow选项` 中锁定各角色的账号、模型与预算，再由秘书按需启动或转达中途修正。
- **独立后台运行与真实问答**：`hmz` 流程独立于 DSH 运行，关闭网页或停止秘书的单次回复都不会中断后台任务；当流程角色向人类提问时，秘书会弹出原生问答卡交由你本人回答，绝不代答。
- **会话专属的任务视图**：无需额外部署 `hmz web`，直接在当前 DSH 会话的 **Flow** 标签页即可查看本会话启动的任务拓扑、角色进度与实时日志，任务列表按 DSH 会话区分。
- **流程提醒与写保护**：默认开启只读旁路观察（每次任务默认最多调用 6 次秘书模型，费用独立于 `hmz` 任务预算之外），仅在出现关键取舍或反复报错时给出提醒；运行期自动启用本会话写保护，防止与后台流程并发改写文件。

## 环境要求与快速开始

### 前置条件

- 已安装支持所需插件接口的 **DSH**，以及 **hmz**（humanize）。
- `scripts/preview.sh` 要求 `hmz` 采用独立安装布局，即同时包含 `<hmz-root>/bin/hmz` 与 `<hmz-root>/venv/bin/python`（其他安装布局的配置方式见 [配置与运行指南](./docs/configuration.md)）。
- 系统工具 `bash`、`git`、`tmux`，以及用于运行测试的 Node.js 与 `npm`。

### 获取源码与配置预览环境

预览脚本会在仓库下的 `.preview/` 目录创建隔离环境，不修改你现有的 `~/.dsh` 与 `~/.hmz`。

```bash
git clone https://github.com/DYZhang-ai/dsh-hmz.git
cd dsh-hmz

# 1. 显式指定本机 DSH 与 hmz 的绝对路径
export DSH_BIN='/absolute/path/to/dsh'
export HMZ_BIN='/absolute/path/to/hmz-root/bin/hmz'

# 2. 初始化预览目录（可选复制现有 DSH 凭据，但该步骤不会配置 hmz 账号）
PREVIEW_CREDENTIALS_FROM="$HOME/.dsh" scripts/preview.sh prepare

# 3. 在预览环境的 hmz 主目录中打开 hmz TUI 配置显式账号
HUMANIZE_HOME="$PWD/.preview/hmz-home" TMPDIR="$PWD/.preview/tmp" "$HMZ_BIN"
```

如果流程角色使用 `dsh` 后端，请在打开的 hmz 终端界面中输入 `/settings accounts`，添加显式 `dsh` 账号，保存后退出。当前 hmz 的无账号读取方式不支持新版 DSH 凭据格式；复制 DSH 登录信息不能替代这一步。使用其他后端时，按该后端的要求配置。随后启动预览：

```bash
# 4. 启动隔离预览服务
scripts/preview.sh start

# 5. 查看运行状态（停止预览服务可执行 scripts/preview.sh stop）
scripts/preview.sh status
```

启动后，可从 `.preview/private/dsh-url` 读取带访问令牌的登录地址（该启动地址也会输出到本地日志 `.preview/logs/dsh.out` 中）。

注意：`scripts/preview.sh stop` 仅停止预览的 DSH Web 服务，不会停止正在运行的 flow；如需终止活跃任务，请使用界面中的 **停止 flow**（Stop flow）按钮。更多预览参数与凭据复用说明请参考 [配置与运行指南](./docs/configuration.md)。

## 首次使用四步上手

1. **选择流程**：打开预览页面并选择工作目录，点击输入框左下角 **＋ → 指令 → Flow**（或输入 `/`）选择流程（如 `rlar` 或 `chat`）。此时不会启动任务。
2. **配置选项**：点击输入框下方的 **`flow选项 · <流程名>`**，为各角色选择 CLI、刚添加的显式账号与模型，填写至少一项预算上限（`chat` 除外）并点击 **保存**。
3. **对话与调度**：在输入框中与秘书交流——可先讨论方案，准备好后再让秘书启动工作；运行中可随时通过秘书转达修正要求，或回答弹出的真实问题。
4. **观察与停止**：切换到顶部 **Flow** 标签页查看本会话任务的实时进展，或在输入框上方查看旁路 **流程提醒**；如需终止任务，点击界面上的 **停止 flow**。

## 已知限制与运行边界

- **停止回复不等于停止流程**：`hmz` 在独立后台运行；取消秘书的回复或关闭网页不会中止后台流程，停止任务需使用界面中的 **停止 flow** 按钮或明确指令。
- **流程提醒可关闭**：在 `flow选项` 或提醒卡片中关闭；它的额外模型调用费用不受 hmz 任务预算约束。
- **单目录单任务与写保护范围**：同一工作目录同时只能运行一个流程。运行期写保护仅作用于当前 DSH 会话及其子代理，不限制外部进程或其他会话，并非多租户安全隔离。
- **启动结果未知时不要重复启动**：插件会按请求标识核对后台状态，确认之前保持写保护，避免重复创建任务。
- **任务视图版本兼容性**：会话级任务视图已针对 **`hmz 0.2.2`** 验证；若新版 `hmz` 的前端静态模块发生结构性变更，可能导致视图显示异常，而仅涉及局部锚点变化时则会自动跳过实时刷新补丁。

完整的设计取舍与边界说明请参阅 [架构与设计边界](./docs/architecture.md) 及 [配置与运行指南](./docs/configuration.md)。

## 测试与贡献

在仓库根目录下即可运行插件单元测试（无需启动预览服务或配置大模型凭据）：

```bash
npm --prefix packages/dsh-hmz-flow test
```

Python 适配层测试、浏览器测试与开发约定见 [开发与测试指南](./docs/development.md)。欢迎通过 [Issues](https://github.com/DYZhang-ai/dsh-hmz/issues) 反馈问题或通过 [Pull Requests](https://github.com/DYZhang-ai/dsh-hmz/pulls) 参与贡献。

## 项目状态

- **软件包状态**：`@dsh-hmz/flow`（`packages/dsh-hmz-flow`）当前版本为 `0.1.0`，设置为 `private: true`，当前按本地源码加载。
- **许可证**：仓库目前尚未包含 `LICENSE` 文件。
