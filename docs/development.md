# 开发、测试与贡献指南

本文档面向参与 `@dsh-hmz/flow` 开发与维护的贡献者，介绍仓库结构、各层测试的运行方式（含环境变量与前置要求）以及代码贡献规范。

---

## 1. 仓库目录结构

```text
.
├── packages/
│   └── dsh-hmz-flow/                # @dsh-hmz/flow DSH 外部插件包 (private: true, v0.1.0)
│       ├── index.js                 # Host 端入口：RPC 路由、秘书工具、写保护守卫、观察器挂载
│       ├── client.js                # Client 端入口：＋ 与 / 菜单、flow选项面板、提醒卡片、Flow 页
│       ├── cordis.patch.yml         # Bundle 默认注入补丁（具体路径配置由 profile 覆盖）
│       ├── adapter/
│       │   └── hmz_adapter.py       # 外置 Python 适配层：通过 stdio JSON-lines 调用 hmz SDK
│       ├── lib/
│       │   ├── adapter-client.js    # Node 侧 stdio 子进程管理与结果分类（refused/not-sent/unknown）
│       │   ├── controller.js        # 会话级串行控制、启动前静默检查、精确身份校验与状态轮询
│       │   ├── history.js           # “附带前文”可见消息快照提取与截断
│       │   ├── message.js           # DSH 通知消息构造与回退工厂
│       │   ├── observer.js          # 流程提醒调度器、进程级并发闸门与状态管理
│       │   ├── observer-prompt.js   # 流程提醒提示词构造与严格 JSON 回复解析
│       │   ├── options.js           # Flow 选项校验与启动参数冻结
│       │   ├── policy.js            # 运行期写保护工具白名单与代理树归属判定
│       │   ├── present.js           # 秘书工具与系统提示词的纯文本格式化
│       │   ├── runview.js           # Flow 页按 DSH sessionId 隔离的数据视图
│       │   ├── state.js             # state.json 原子持久化存储与版本迁移
│       │   ├── viewer-patches.js    # 针对 hmz views/epic.js 的 5 个实时刷新内存补丁
│       │   └── viewer-route.js      # /hmzf-viewer/ 静态资源白名单路由与 CSP 构造
│       ├── viewer/                  # 沙箱 iframe 内的桥接脚本、单 run 路由与 app/sidebar shim
│       ├── locale/                  # 插件元信息中英文文案
│       └── tests/                   # Node 行为测试 (*.test.js) 与适配层 Python 单元测试 (*_unit.py)
├── scripts/
│   └── preview.sh                   # 启动/停止隔离 DSH Web 预览环境的脚本
└── tests/
    ├── e2e/                         # 真实 hmz SDK 集成测试与 Playwright 浏览器端到端测试
    └── fixtures/
        └── make_demo_epic.py        # 在隔离 hmz home 中生成真实 chat epic 的辅助夹具
```

---

## 2. 运行测试

请在**仓库根目录**下执行以下命令。测试分为四个层级，前两层无需启动预览服务、也无需调用外部大模型。

### 2.1 Node 单元测试与打包检查（无外部依赖）

Node 行为测试使用 Node.js 内置的 `node --test` 运行器，共包含 8 个测试文件（覆盖状态存储与迁移、会话隔离与 `403` 越权拦截、控制器启动 Fence、写保护策略、秘书显式启动语义、取消信号处理、视图补丁与 CSP、以及流程提醒的进展触发/失败重试/诊断落盘/指纹/进程级闸门/多会话轮转）：

```bash
# 运行全部 Node 行为测试
(cd packages/dsh-hmz-flow && npm test)

# 检查打包文件清单（确认 index.js、client.js、lib/*、viewer/*、adapter/* 等均包含在内）
(cd packages/dsh-hmz-flow && npm pack --dry-run)
```

### 2.2 Python 适配层单元测试（需 `hmz` Python 环境，无守护进程/无模型）

[`packages/dsh-hmz-flow/tests/`](../packages/dsh-hmz-flow/tests/) 下的 3 个 Python 单元测试通过故障注入与轻量级 SDK 替身验证 `hmz_adapter.py` 的核心逻辑，不启动 `hmz` daemon，也不发起网络请求。

请将 `HMZ_PYTHON` 指向你本地 `hmz` 独立安装目录下的 `venv/bin/python`（若路径含空格请保留引号）：

```bash
HMZ_PYTHON="/abs/path/to/hmz-root/venv/bin/python"
ADAPTER="packages/dsh-hmz-flow/adapter/hmz_adapter.py"

# 1. 启动绑定故障注入测试（验证超时、连接断开或快照被其他 run 抢占时不产生脏绑定）
"$HMZ_PYTHON" -I packages/dsh-hmz-flow/tests/adapter_start_unit.py "$ADAPTER"

# 2. Epic 读取与作用域单元测试（验证符号链接越界拦截、复合 session key 与 15s 缓存 TTL）
"$HMZ_PYTHON" -I packages/dsh-hmz-flow/tests/adapter_epic_unit.py "$ADAPTER"

# 3. 流程提醒证据提取单元测试（验证消息、工具输入/输出独立预算、最新指令提取、截断标记与指纹）
"$HMZ_PYTHON" -I packages/dsh-hmz-flow/tests/adapter_observe_unit.py "$ADAPTER"

# 4. 使用真实 hmz 日志解析器验证首个 Actor turn（只替换 daemon 传输，不启动进程或模型）
"$HMZ_PYTHON" -I packages/dsh-hmz-flow/tests/adapter_live_sdk.py "$ADAPTER"
```

### 2.3 真实 `hmz` SDK 适配层测试（按需，在隔离 `HUMANIZE_HOME` 中运行）

[`tests/e2e/`](../tests/e2e/) 下包含直接驱动 `hmz_adapter.py` 对接真实 `hmz` 安装的脚本：

1. **历史冒烟脚本**：`tests/e2e/adapter_smoke.py` 仍断言适配层不提供 `start` 操作，与当前实现不符；修订断言之前，不应将它作为当前版本的验收命令。
2. **真实控制动作测试（会运行真实模型并产生费用）**：
   - `tests/e2e/adapter_actions.py` 与 `tests/fixtures/make_demo_epic.py` 会在隔离的 `HUMANIZE_HOME` 中启动真实的 `chat` flow。
   - **前置条件**：隔离的 `HUMANIZE_HOME` 中已配置好显式 DeepSeek 账号（默认读取环境变量 `HMZ_TEST_AGENT`，未设置时默认为 `dsh@preview-deepseek/deepseek-flash`；脚本明确拒绝 `claude` 后端）。
   ```bash
   HMZ_PYTHON="/abs/path/to/hmz-root/venv/bin/python"
   ADAPTER="packages/dsh-hmz-flow/adapter/hmz_adapter.py"
   PREVIEW_DIR="$PWD/.preview"

   HUMANIZE_HOME="$PREVIEW_DIR/hmz-home" \
   TMPDIR="$PREVIEW_DIR/tmp" \
   HUMANIZE_DSH_BIN="/abs/path/to/dsh" \
   HMZ_TEST_AGENT="dsh@<your-account>/deepseek-flash" \
     "$HMZ_PYTHON" -I tests/e2e/adapter_actions.py "$ADAPTER" "$PREVIEW_DIR/demo"
   ```

### 2.4 浏览器端到端测试（Playwright）

[`tests/e2e/`](../tests/e2e/) 中的浏览器测试使用 Python 版 Playwright 驱动已启动的隔离预览实例。

**前置要求**：

1. 已按 [配置与运行指南](./configuration.md) 启动目标预览目录（例如 `$PWD/.preview-test`，其中包含 `private/dsh-url`）。
2. 准备一个安装了 `playwright` Python 包的解释器 `PW_PYTHON`。
3. 检查 [`tests/e2e/dshpage.py`](../tests/e2e/dshpage.py) 中的 `CHROME` 常量：该辅助模块目前写有开发机的 Playwright Chromium 缓存路径，在其他机器上运行浏览器 E2E 前，请确认或调整为你本机的 Chromium 可执行文件路径。

**不调用大模型的浏览器 UI 与 RPC 测试**：

```bash
PW_PYTHON="/abs/path/to/playwright-venv/bin/python"
PREVIEW_DIR="$PWD/.preview-test"

# 验证 ＋ 菜单与 / 菜单选择 flow、保留输入框草稿、打开 flow选项 面板且不自动启动
(cd tests/e2e && "$PW_PYTHON" plus_menu.py "$PREVIEW_DIR")

# 验证提醒卡片与操作、纯文本渲染，以及 budget.duration 秒与表单分钟的往返（RPC 由测试应答）
(cd tests/e2e && "$PW_PYTHON" observer_ui.py "$PREVIEW_DIR")

# 验证跨会话切换、同会话切换 run 时迟到/乱序 observer 回复的丢弃与状态行显示
(cd tests/e2e && "$PW_PYTHON" observer_race.py "$PREVIEW_DIR")

# 验证原生 viewer 在 detail 不变、trace 新增消息时的 4 秒实时刷新、滚动保持与控件隐藏
# （需先通过适配层 web_detail / web_trace 导出一份真实 epic 的 JSON 作为夹具输入）
DSH_PORT=44190  # 改为目标预览的实际端口
(cd tests/e2e && "$PW_PYTHON" viewer_live_fixture.py "$DSH_PORT" /path/to/detail.json /path/to/trace.json)

# 验证真实 Host + SDK 的会话级 RPC 读取与跨会话 403 拒绝（需预览 state.json 中已有至少一条已结束的 epic 记录）
(cd tests/e2e && "$PW_PYTHON" flow_rpc_real.py "$PREVIEW_DIR")
```

> **关于历史脚本的说明**：`tests/e2e/verify_flow.py` 是早期迭代编写的自动化验收脚本，其中包含旧版“点击保存后选项面板仍保持打开”等已变更的交互断言，仅保留作为历史参考，不代表当前的面板自动收起行为。

---

## 3. 历史验收背景摘录

原 README 记录了以下在真实 DeepSeek 账号与 `hmz 0.2.2` 环境下的验收场景。原始产物不在本仓库内，这里保留为历史背景；它们不代表每次文档修改都重新执行过这些验收：

- **秘书自然语言路由**：选中 `rlar` 后先进行普通问答与讨论，确认既不触发启动也不转发消息；当用户以自然语言明确要求将任务交给所选流程时，秘书调用一次 `hmz_flow_start`，由 `actor` / `reviewer` 完成工作；任务结束后的后续讨论不再新建 run 或误转发。
- **真实停止链路**：运行中的 `chat` 流程点击停止 → 进入 `stopping` → 经 SDK 与 epic 记录双重确认为 `ended` 并释放写保护。
- **原生视图实时刷新与会话隔离**：当 `detail` 元数据固定而 `trace` 追加新消息时，线程视图按 4 秒周期请求新记录（适配层另有缓存，端到端刷新延迟不保证为 4 秒），run 结束后停止轮询；跨会话调用 `viewDetail`、`viewTrace`、`stopRun` 均返回 `403`；DSH 重启后自动接回同一 run。
- **面板与菜单交互**：`flow选项` 保存成功自动收起、保存失败保持打开并报错；通过 `＋` 菜单选择 flow 时输入框草稿与选中文本完整保留。

---

## 4. 贡献指南

本仓库当前处于早期开源整理阶段（`@dsh-hmz/flow` 版本 `0.1.0`，包标记为 `private: true`，暂未配置托管 CI 工作流）。欢迎通过 Issue 或 Pull Request 参与改进：

1. **遵守非侵入边界**：
   - 请勿依赖未公开的 DSH 内部模块私有路径或修改已安装的 `hmz` 源码。
   - 若涉及 `lib/viewer-patches.js` 中的原生视图补丁，必须保持精确锚点匹配，并确保在锚点缺失时能安全回退到原样静态文件。
2. **保持诚实的状态与错误处理**：
   - 严禁在 `start`、`say`、`answer`、`stop` 结果为 `unknown` 时引入盲目自动重试逻辑。
   - 任何新增的客户端 RPC 都必须校验 `sessionId`，并通过 `RunView.resolve` 确保只能访问该会话自身启动的 run。
3. **保护凭据与本地路径隐私**：
   - 切勿提交 `.preview/`、`.preview-*/`、`.credentials.yaml`、`private/dsh-url`、包含真实 token 的日志或带有个人开发机硬编码路径的文档与测试配置（相关模式已列入 [`.gitignore`](../.gitignore)）。
4. **提交前自检**：
   - 修改插件逻辑后，请至少在本地运行 `(cd packages/dsh-hmz-flow && npm test)` 以及 3 个 `adapter_*_unit.py` 测试和 `adapter_live_sdk.py`，确保全部通过。
