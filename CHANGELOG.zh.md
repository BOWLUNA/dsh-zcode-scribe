# 更新日志

[English](CHANGELOG.md) | 简体中文

本项目的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

与 dsh 的兼容性写在 `package.json` 的 `engines.dsh` 里，并由 `tools/verify-version-consistency.mjs`
断言；某份发布说明里点名的 dsh 版本，就是 CI 实际跑过的版本。

一条关于版本号的说明，因为下面这段历史并不是一条直线：**0.1.x 是开发期记录，从未发布过。**
1.0.0 是首个公开发布版。版本线现在由五个 `dsh-zcode-*` 插件共用——它们是同一件事的五个部分，
而不是五个彼此独立的项目。

---

## [未发布]

### 新增

- 暂无。**写入是下一个里程碑**，而它卡在 `AGENTS.md` 所述的 M0 探针上：在做抽取之前，必须先证明
  「子代理的能力集真的能通过公开接缝被收窄」。如果证明不了，抽取功能**不上线**，
  而不是退化成让主 agent 用全套工具去写记忆。

### 修复

- **打了 tag 的 1.0.0 装不上。** 包名从 `dsh-scribe` 改成 `dsh-zcode-scribe` 之后，
  `cordis.patch.yml` 里的行名仍是旧的；而装载器在应用整棵树时，是把该字段当作模块名、
  **从 profile 目录**去解析的 —— 于是 profile 直接死在 `Cannot find package 'dsh-scribe'`。
  它能装上、单测全过、`--dump-config` 干净且 stderr 为空；但这几项**都不 apply 插件**，
  所以 CI 一直是绿的。现在行名与 `package.json` 一致。
- `tools/boot-check.mjs`：把插件真装进一次性 `DSH_HOME` 并真启动的守卫，四条断言 ——
  安装 exit 0；`cordis.patch.yml` 的行 `name` 等于 `package.json` 的 `name`
  （**直接读文件**，因为 `--dump-config` 没有任何解析状态的痕迹可查）；
  在超时内 `net.connect` 到端口成功（**探端口，不探日志** —— Electron 那份构建从不打印监听 URL）；
  以及端口应答那一刻 stderr 为空。**exit 1 会点名是哪条断言失败，exit 2 表示环境跑不了这条检查**。
  两道工作流里都会跑。
- **harness 是被「找到」的，不是被假定的。** `tools/boot-check.mjs` 与 `tools/resolve-dsh.sh`
  按同一个顺序解析它 —— `--dsh-bin` → `$DSH_INSTALL` → 本地 `node_modules` 安装 → PATH 上的 `dsh`；
  `install.sh` / `uninstall.sh` **共用同一个 resolver**，而不是各自写死一个路径。
  写死的那个正是 2026-09-21 失效的东西：桌面 harness 从 `C:\BL\AI\DSH Desktop`
  搬到了 `C:/BL/AI/dsh-harness` —— 而 `install.sh` 的救援提示（用户装不上时**唯一**看到的指引）
  指向两个已不存在的目录，`AGENTS.md` 也在让人遵守一条指向已消失路径的规则。
- `.gitignore` 补了一条**不带斜杠**的 `node_modules`。带斜杠只匹配目录，
  所以同名的符号链接 / junction 并不会被忽略。
- `test/run.mjs` 钉死 `--test-reporter=tap`。Node 24 把「stdout 非终端」时的默认 reporter
  从 `tap` 改成了 `spec`，导致 `tools/verify-doc-numbers.mjs` 在 Node 24 上读不到 live 摘要，
  而在 Node 22 上仍然正常。
- `release.yml` 现在会从 tag 建出 GitHub Release。它原先声明的是 `contents: read` 且没有这一步，
  于是推了 tag 只更新了代码，仓库的 Releases 面板毫无动静。

---

## [1.0.0] — 2026-09-21

首个公开发布版。**只读，且是刻意的。** 这次发布的意义在于：先把三条安全属性用代码和测试立起来，
趁还没有任何功能需要靠牺牲它们来保住。

### 包含

- 给 DeepSeek Harness 的长期记忆，写记忆的那个组件是一个被硬收窄了权限的子代理。1.0.0 只交付
  **读半边**，并且明说这一点——写在 README 的状态横幅里，也写在工具自己的描述里。
- `scribe_recall`，一个只读工具：返回记忆索引、一份「主题文件名 + 其一句话描述」的召回清单，
  以及可选的某一个主题正文。**正文永远不会被自动注入。**
- 记忆房间的路径规则：四道归一化（Unicode 控制字符与双向字符、NTFS 备用数据流、尾部点与空格、
  平台相关的大小写折叠）外加一份段黑名单，按**相对记忆根的路径**比对。
- 200 行 / 25000 字符的索引上限，其截断**永远会被报告**，并点名维度、当前值与上限。
  **静默截断永远不可接受。**
- 会话提示词首次组装时冻结的快照：既让提示词前缀可缓存，也阻止一次召回去改写「造成它的那个会话」的指令。

### 兼容性

- 在 dsh `0.1.5-rc.2`（Windows 桌面版）与 dsh `0.1.6-alpha.2`（WSL 版）上开发并验证过。
  两条线都在 CI 矩阵里，`engines.dsh` 声明的正是这一对。
- 用到的宿主 API：`ctx.logger`、`ctx.tools.register`（在 `ctx.effect` 内）、
  `ctx.systemPrompt.section`；以及来自 `@deepseek-ai/dsh-tools` 的 `defineTool`
  与来自 `@deepseek-ai/schemastery` 的 schema DSL。会话工作区从
  `exec.agent.session.header.cwd` 读取。
- `--dump-config` **不是**启动测试——它只合成配置、从不 apply 插件，所以对一个根本起不来的 profile
  它也会报出干净的树。这个代价记在 `docs/TROUBLESHOOTING.md` 里。

### 尚未包含

- 写入、抽取，以及那个被收窄的写手本身。工具名一律带 `scribe_` 前缀，因为工具名在每个宿主里是全局的、
  重名是**启动硬失败**；本插件设计上要与之协作的 `dsh-memento` 已经占用了 `memory` 与 `memory_recall`。

---

## [0.1.0] — 2026-09-21

开发期记录，从未发布、也从未打 tag。它标记的是「读半边、路径规则与守卫第一次一起跑绿」的那个点。
留下来是为了不丢掉安全决策的历史；要知道实际发出去了什么，看 1.0.0。

[未发布]: https://github.com/BOWLUNA/dsh-zcode-scribe/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BOWLUNA/dsh-zcode-scribe/releases/tag/v1.0.0
[0.1.0]: https://github.com/BOWLUNA/dsh-zcode-scribe/compare/v0.1.0...v1.0.0
