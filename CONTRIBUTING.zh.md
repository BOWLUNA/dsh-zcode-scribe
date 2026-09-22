# 参与贡献
[English](CONTRIBUTING.md) | 简体中文

感谢驻足。本文件讲**怎么跑**与**会被检查什么**；规则的来由在 `AGENTS.md`
（面向机器的清单）与 `docs/ARCHITECTURE.md`。

## 环境

Node `>= 20`。**没有运行时依赖，也没有构建步骤。**

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-scribe
cd dsh-zcode-scribe
node test/run.mjs          # 104 项测试 / 16 个套件，无需安装
```

测试套件会 import 两个宿主包：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
CI 里它们来自安装一份 harness；本地通常来自你已经有的那份 harness。
`docs/TROUBLESHOOTING.md` 解释了让 checkout 能解析它们的那个
`node_modules/@deepseek-ai` junction。

## 推之前

```bash
node test/run.mjs                                   # 1. 测试
node tools/verify-translation-pairing.mjs --write    # 2. 只有改了文档才需要
node tools/verify-doc-numbers.mjs                   # 3. 文档里的数字
bash -n install.sh && bash -n uninstall.sh          # 4. shell 语法
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2   # 5. 必须带 --dsh
```

第 2 步是一条**声明**，不是检查：它记录两种语言两侧此刻一致。
**只有真的改了两侧之后才跑它。**
第 5 步断言「给定的那个 dsh 版本落在本包声明的区间内」，它**必须**带 `--dsh`——
不带参数时脚本会直接退出 1，而不是去猜。

## 两条比代码风格更要紧的规则

**安全属性不是功能开关。** `docs/ARCHITECTURE.md` §1.2 描述的那三条属性是本项目存在的理由。
削弱其中任何一条的改动，都必须在 diff 里写明**放弃了哪条属性、用什么替代**；
任何能关掉某条属性的配置键，都必须在它自己的注释里点名这个损失。

**每条规则都要有一条「把规则删掉就会红」的测试。** 没有测试的规则只是注释。
如果你加了一道守卫，就把证明它会红的那个变异用例一起加上。

## 文档

面向用户的文档都存两版：`X.md`（英文）与 `X.zh.md`（中文），
并由 `X.i18n.yaml` 记录两侧在上次确认一致时的 git blob 哈希。
**两者是同一份文档**：改一侧就改另一侧，然后重录。配对守卫还会查语言纯度，
所以半翻译的文件会红。

命名统一用 `.zh.md`，不要用 `.zh-CN.md`。

`docs/` 下的设计文档**按声明只保留英文侧**——`tools/verify-translation-pairing.mjs`
里点名了它们与理由，并且**每次运行都会把这个缺口打印出来**。

## 范围纪律

**把七件事修完整、每件配一条守卫，胜过动十五件、每件半绿。**
如果一个问题真实存在但超出本次改动的范围，就开 issue，不要顺手改——
这是让一次评审保持可读的办法。

## 拉取请求

模板里列了必须具备的条件。有两点值得重复：

- diff、测试夹具、日志里都不得出现凭证、令牌或记忆房间的内容。
- 如果文档里的数字变了，两种语言两侧都要改，并重录配对哈希。
  参考项目曾经因为「改了数字忘了第二步」让四条 CI 矩阵全红过一次。
