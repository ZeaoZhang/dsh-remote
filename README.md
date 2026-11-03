[English](./README.en.md) · **中文**

---

# dsh-remote

[![npm version](https://img.shields.io/npm/v/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dw/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dm/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![license](https://img.shields.io/github/license/flymysql/dsh-remote)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

由 [@flymysql](https://github.com/flymysql) 维护 · [主页](https://flymysql.github.io/dsh-remote/) · [用量统计](https://flymysql.github.io/dsh-remote/stats/) · [博客](https://gitpull.cn) · [讨论区](https://github.com/flymysql/dsh-remote/discussions) · [Issue](https://github.com/flymysql/dsh-remote/issues) · [English](./README.en.md)

![dsh-remote —— 把任意 SSH 机器变成真正的 DSH 工作区](docs/cover.png)

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的远程工作助手。**

维护多台 SSH 机器，然后在「选择工作区」时选一个**远程工作区**（或**本地工作区**），Agent 就能在不离开 harness 的情况下直接操作——列文件、读代码、在远程主机上跑构建/命令，并把远程目录镜像成一个真实的本地工作区对象。

DSH 的 Web 界面刻意只监听 `127.0.0.1`（CLI 为安全拒绝 `--host 0.0.0.0`）。本插件反过来：**由你主动连出**到你维护的机器，选一个工作区，然后通过 DSH 原生的工作区 + 文件流来工作——**不改动 `dsh-workspace` 核心**。

反过来也成立：**你可以把远端那台机器的 DSH 网页界面，当成本机浏览器里的一个页面打开**——同样不需要在远端开放任何端口（详见 [在本地打开远程机器上的 DSH 界面](#在本地打开远程机器上的-dsh-界面)）。连不上时还有**一键体检与部署**，它会替你把远端环境修好并验证。

## 界面预览

**设置 → 远程工作区** —— 多机列表、高级配置（私钥/跳板机/agent）、连接体检、远程 DSH 界面、端口转发、审计日志、更新：

<img src="docs/shots/settings-panel.png" alt="dsh-remote 设置页：机器列表、高级配置、远程 DSH 界面、体检与部署、端口转发、审计日志、更新" width="612"/>

原生 **「Add workspace / 选择工作区」** 流程 —— 居中弹窗、两个 tab，默认落在「本机」；切到**「远程」**：

<img src="docs/shots/picker-dialog.png" alt="选择工作目录弹窗的「远程」tab：机器下拉、最近工作区、浏览…、设为远程工作区" width="632"/>

- 路径框实时补全；Windows 主机根级显示「此电脑」多盘视图；「浏览…」浮层选中只回填、不直接提交。
- 确定后创建**真实本地镜像**并被 harness 收养，同时通过 SFTP 保持同步；所选工作区持久化到该机器。

---

## 功能

![核心能力总览 — 多机 SSH / 别名实时解析 / 双 tab 选择器 / 三路同步 / 远程 @ 补全 / 远端 DSH 界面挂到本机 / 体检与一键部署 / 安全审计 / 端口转发 / 侧栏编辑 / 自动更新，以及 22 个 rw_* 工具](docs/shots/features.png)

上图是能力总览；下面只列**上图没说清、但用起来需要知道**的部分。

其余要点：

- **legacy 模式的 22 个模型工具**（便于复制/检索）：`rw_info`、`rw_connect`、`rw_machines`、`rw_pick_workspace`、`rw_list_dir`、`rw_stat`、`rw_read_file`、`rw_write_file`、`rw_edit`、`rw_append`、`rw_mkdir`、`rw_remove`、`rw_move`、`rw_exec`、`rw_search`、`rw_download`、`rw_upload`、`rw_sync`、`rw_push`、`rw_forward`、`rw_disconnect`、`rw_deploy_probe`。
- **会话列表里区分本地/远程**（`0.8.43+`）—— 远程会话的行首有一个**绿点**，悬停显示 `user@host:port` 与远端路径；打开该会话后，标题栏还会常显一个主机标签（本地会话两者都没有）。判定只看会话 cwd 是否落在 `$DSH_HOME/remote-workspaces/…` 镜像里，所以「保存过但没在用」的机器不会给本地会话打标。
- **把远端机器的 DSH 界面挂到本机**（`0.8.36+`）—— 不用在远端开任何端口：插件主动 SSH 连过去，在远端**只监听 `127.0.0.1`** 地起一个 `dsh web`，再把端口经隧道搬回本机的一个 loopback 端口。地址带一次性登录令牌，只在本机这次跳转里用一次。
- **连不上时一键体检与部署**（`0.8.36+`）—— **连不上大多不是插件的问题，而是远端 dsh 的版本或环境不对**。体检（只读）会报出平台/node/npm/dsh 版本、**原生模块能否启动**、代理与 npm 源，并给出修复建议；「部署并验证」把它装到远端**私有目录**（不写系统目录、不改 PATH、不覆盖你在用的版本，删目录即回滚）并逐步校验。按钮**不再需要先体检**——直接点即可（`0.8.40+`），部署过程自己会重新体检。失败还能交给内置的 `dsh-remote-deploy` 技能排查。
- **远端跨平台** —— 文件访问走 SFTP 协议层（不依赖 POSIX shell），Linux/macOS/Windows 远端都能列/读/写/搜索/同步。
- **Windows 主机** —— 自动探测平台并定位 Git Bash，命令经 `bash -s` 走 stdin 执行，不受引号/反斜杠转义困扰（`config.shell` 可指定或设 `native` 关闭）；`C:\Users\dev` 与 `/c/Users/dev` 两种写法都接受。
- **长任务异步化** —— `rw_sync`/`rw_push` 传 `async: true` 返回 `taskId`，可查询进度/结果/取消。
- **数据跟随 Harness 根目录** —— 机器清单与镜像在 `$DSH_HOME/remote-workspaces`；0.6 之前的数据首次启动自动迁移。
- **`~/.ssh/config` 是连接四字段的唯一来源**（`0.8.50+`，issue #50）—— 保存机器时把 主机/用户/端口/私钥 写入 `~/.ssh/config` 的受管块（`# dsh-remote: managed` 标记，只动自己的块；你手写的同名 Host 块绝不覆盖，会提示冲突）。之后**改这个文件立即生效**：任何 Host 块点名的主机（含字面 IP），连接都按文件解析（裸 `Host *` 是通用默认，不算点名）；机器记录里的副本只做兜底，插件自己的状态（最近工作区/延迟等）仍存注册表。
- **不改动 `dsh-workspace` 官方代码** —— 全部作为普通插件实现。

## 安装

### DSH 版本兼容性

同时支持 `0.1.x` 与 `0.2.x` 两条 DSH 线。DSH 会在导入 bundle **之前**校验所有 `@deepseek-ai/dsh-*` 的 peer 范围，**任一条不匹配就整包丢弃**（没有设置页、没有 `rw_*` 工具）：

```
dsh: skipping profile bundle "dsh-remote": Error: Plugin dsh-remote@… is incompatible …
```

caret 在 `0.x` 上会锁死小版本线（`^0.1.x` 容不下 `0.2.x`，反之亦然），所以自 **0.8.29** 起改为跨线区间 `>=0.1.0-rc.6 <0.3.0`。**低于 0.8.29 请在升级 DSH 前先升级本插件**。

### 官方 Desktop 兼容适配（实验性）

对 [DeepSeek 官方 Desktop](https://github.com/deepseek-ai/deepseek-harness) 的适配（以 `0.1.5-rc.2` Host 协议验证，不修改 Harness 核心）：

- 经 `ctx.connection.fetch` 注册 `/api/dsh-remote/*`，由 Desktop 的 `dsh-app:` 通道承载，不启动 Web Server。
- 经 `sidebarRightTabs` 提供原生「远程文件」入口，不把远端路径传给本地预览器。
- `dsh-better-sidebar` 不再内置；官方 Desktop 用原生右侧栏，不需要它。

已验证 Host 启动、IPC 请求、真实 SSH 的只读连接/列目录/读文件，以及双机会话路由（侧栏 `/ls` `/read` `/write` `/fs` 带 `sessionId` 时按会话选机）。原生文件 tab 的完整 GUI、失败/取消交互、非 macOS 宿主仍属实验性。Desktop 安装器可能需为 `ssh2` / `cpu-features` 可选构建脚本配置策略。

### 已发布的 Web bundle

```bash
dsh plugin add dsh-remote
```

自 **v0.8.18** 起只安装并挂载自身；Web 侧边栏（[dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar)）改为可选。需要 Web 版远程文件浏览/编辑时再单独装它；不装时 `rw_*` 工具、设置页、同步、审计与转发均照常工作。

> **从 0.7.2–0.8.17 升级：** 内嵌侧边栏会消失，旧 profile 里 `id: dsh-remote-sidebar` 的覆盖可以删除。

（或 `npm install dsh-remote`，再在 `cordis.patch.yml` 加 `- id: dsh-remote / name: dsh-remote`。）

## 快速上手

1. **加一台机器** —— 设置 → 远程工作区 → 填 host/port/user + 密码或 key → 设为当前。
   > **保存 ≠ 激活**：保存只是备用连接；只有「设为当前」（或 Agent 调 `rw_connect`）才进入会话的 remote context。
2. **选工作区** —— 点侧边栏/会话的 **Add workspace**：
   - **本机** → 系统文件夹选择（或手输路径）→ 本地工作区。宿主没有可用系统对话框时改用插件内置浏览器。
   - **远程** → 选机器 → 浏览到远程目录（或输入 `/path`）→ 「设为远程工作区」⇒ 创建并收养本地镜像工作区。
3. **让 Agent 工作** —— 当作普通工作区使用，例如 `rw_read_file` / `rw_write_file` / `rw_edit` / `rw_exec` / `rw_search` / `rw_sync` / `rw_push` / `rw_forward`（完整列表见上文）。

> **Remote context 是 session 级的**：只有当前 session 的工作区是某个远程镜像时，system prompt 才注入「Remote workspace」段落；普通本地 session 不受影响，模型也不会主动调 `rw_*`。

## 在本地打开远程机器上的 DSH 界面

远程机器上那个 `dsh web` 也可以**当成本机的一个页面打开**（issue #46）。方向仍然是「本地主动连出去」：

> **远端不需要开放任何端口**。DSH 刻意拒绝 `--host 0.0.0.0`（它会把远程代码执行能力暴露到网络上），
> 所以正确的做法是由本机 SSH 连过去，在远端**只监听 127.0.0.1** 地起一个 `dsh web`，
> 再把它的端口经 SSH 隧道搬回本机的一个 loopback 端口。

用法：设置 → 远程工作区 → **「远程 DSH 界面」** → 选一台机器 → **连接并打开**。
浏览器会新开一个标签页，显示的就是**那台远端机器**的完整 DSH 界面（聊天、工具树、设置都在）。

- 界面地址形如 `http://127.0.0.1:3088/?token=…`。那个 token 是远端进程启动时打印的一次性凭据，
  只在**本机**的这次跳转里用一次：DSH 会把它换成 30 天有效的签名 cookie 并跳转到干净的 `/`。
  **请不要把这个带 token 的地址外发**。
- 「断开」只关隧道，**不会**杀掉远端进程（它可能是你在别处也在用的实例）；
  要连远端进程一起停，用「断开并停止远端」——它只会结束**本次由插件启动**的那个进程。
- 若远端已经在跑一个界面（比如你自己在终端里起的），可以选机器后把它的
  `http://127.0.0.1:<端口>/?token=…` 粘进输入框，点「连接已有实例」，插件不会再去启第二个。
- 远端 `dsh` 不在 SSH 登录 PATH 时，用 `webAttachCommand` 指向它的绝对路径；
  想让它别污染远端用户自己的会话/设置，用 `webAttachDshHome` 指一个临时目录。
  **按机器设**：设置 → 远程工作区 → 机器卡片 → 展开「高级」→「远端 dsh 命令」，
  填绝对路径即可（例如
  `/home/you/.nvm/versions/node/v22.19.0/bin/node /home/you/.dsh-remote/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`）；
  留空则用全局的 `webAttachCommand`。「部署并验证」成功后也会自动写进这个字段。
- 隧道跟着 SSH 连接走：连接断了界面会显示「连接已断开」，**不会**影响本机 DSH 进程；
  池自动重连后插件会重新解析远端端口（必要时重启它自己启动的那个远端进程），界面点「重连」即可继续用。
- 远端 node 需要 **≥ 20.12**（dsh 启动要用 `node:util` 的 `parseEnv`，该导出从 20.12 起才有）。
  node 太旧时体检会直接报 blocker：npm 只会给 EBADENGINE 警告、照样把包装完，
  直到启动才崩在 `does not provide an export named 'parseEnv'`，所以必须在装之前拦住。

### 连不上？先体检，再一键部署

**连不上大多不是插件的问题，而是远端 dsh 的版本或环境不对。** 最典型的一种：dsh 0.1.0-rc.6
依赖 `node-pty@1.1.0`，而**那个版本发布的包里没有 `linux-x64` 预编译产物** ⇒ `dsh web`
在 Linux 上根本起不来。这种情况以前只能看到「没拿到启动令牌」，无从判断。

设置 → 远程工作区 → **「远端 dsh 体检与部署」**：

1. **体检（只读）** —— 探测远端平台/node/npm/dsh 版本/**原生模块能否启动**/是否认识
   `--no-open`/代理与 npm 源，给出结论与修复建议。**不写任何东西**，可以随便点。
2. **部署并验证** —— 只在上一步判定「需要且可以自动装」时才出现。它会装到远端
   **私有目录**（默认 `~/.dsh-remote/dsh`）：**不写系统目录、不改 PATH、不覆盖你在用的版本**，
   删掉那个目录即完全回滚。装完逐步校验（二进制 / 原生模块 / `web` 子命令），
   成功后**按机器记住**这条 dsh 路径，之后连接就用它。
3. **让 AI 排查** —— 只在失败后出现。它会创建一个会话，让内置的 `dsh-remote-deploy`
   技能去处理确定性流程覆盖不到的长尾（没有 npm、要 sudo、代理、内网镜像源、Windows 远端等）。
   **只有你点它才会创建**，因为这会消耗模型额度。

相关配置：`webInstallPrefix`（装哪，默认 `$HOME/.dsh-remote/dsh`）、
`webInstallVersion`（装哪个版本，默认 `0.1.5-rc.2`——第一个在 Linux 上能起 web 的版本）、
`webInstallRegistry`（npm 源；**留空则沿用远端自己的配置**，不会覆盖你的内网镜像）。

## 可选：CLI 默认机

可在 `cordis.patch.yml` 提供默认机：

```yaml
# 示例：请换成你自己的机器
- id: dsh-remote
  name: dsh-remote
  config:
    host: 203.0.113.10   # 或你的真实主机 / hostname
    port: 22
    username: dev
    privateKeyPath: ~/.ssh/id_rsa
    # 或用密码登录：
    # password: '…'
    workspace: ~/project
```

若 `host` 为空，插件启动时处于断开状态，在 UI 里配置机器即可。

## 常用命令（安装 / 查看 / 启动）

DSH 的 `dsh` 可能不在某些 shell 的 PATH（比如 Windows PowerShell 里在某个仓库目录下），所以同时列出 `dsh` 与 `npx` 两种写法。操作都要用 `--profile <name>` 指定 profile（一般 `web`）：

```bash
# 安装（从 npm 拉到 profile）
dsh plugin --profile web add dsh-remote
# 同一效果：当 `dsh` 不在 PATH 时用 npx
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote

# 确认已装
dsh plugin --profile web list
npx --yes @deepseek-ai/dsh plugin --profile web list

# 启动 web 界面（重载 profile，新插件在启动时生效）
dsh --profile web
npx --yes @deepseek-ai/dsh --profile web   # 访问 http://127.0.0.1:3080

# 迭代用本地源码替换 npm 版（便于改 dsh 插件代码后即测）
npx --yes @deepseek-ai/dsh plugin --profile web add D:/path/to/dsh-remote
npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-remote   # 恢复用发行版
```

启动成功后，设置 →「远程工作区」会出现；「Add workspace」流程会带「本机 / 远程」两个 tab（见上方效果图）。

## 开发（沙箱优先，勿改产品）

迭代一律在沙箱里做——手工改产品 profile 会被插件管理器在重装时还原：

```bash
scripts/dev-run.sh --restart   # 启动 / 重启隔离沙箱
scripts/dev-run.sh --stop      # 停止
scripts/dev-run.sh --status    # 是否在运行
```

- 沙箱自带独立 DSH 实例（仓库内 `dev-harness/harness`），UI 在 `http://127.0.0.1:50599`。
- **宿主半**（`lib/index.js`）改动需 `--restart`；**客户端半**（`lib/client.js`）改动刷新页面即可。
- 脚本用**硬链接拷贝**把 `lib/` 放进沙箱而非软链——软链会破坏 `@deepseek-ai/*` 的解析。
- 提交前跑 `node check.mjs`（框架约束闸门）与 `npm test`；`scripts/boot-smoke.sh` 证明插件仍能启动。
- 完整规则见 `scripts/dev-standards.md`。

部署到产品 profile 是单独的受控动作（`./sync.sh`），只在确定要发布时做。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | `''` | 默认 SSH 主机（空=断开） |
| `port` | int | `22` | 默认 SSH 端口 |
| `username` | string | `''` | 默认 SSH 用户 |
| `password` | string | `''` | 默认 SSH 密码（非空覆盖 key） |
| `privateKeyPath` | string | `''` | 私钥路径（仅在显式提供时使用） |
| `passphrase` | string | `''` | 加密私钥的 passphrase |
| `workspace` | string | `''` | 默认远程工作区路径 |
| `shell` | string | `''` | 远程命令终端策略：`''`=自动检测（Windows 找 Git Bash）、`'git-bash'`=优先 Git Bash、`'native'`=不包装、其他=显式 bash.exe 路径（如 `C:\Program Files\Git\bin\bash.exe`） |
| `commandTimeoutMs` | int | 20000 | 单条远程命令超时 |
| `connectTimeoutMs` | int | 15000 | SSH 连接超时 |
| `maxOutputChars` | int | 200000 | 单条远程命令捕获的 stdout/stderr 上限 |
| `maxFileBytes` | int | 52428800 | 镜像同步时跳过超过该大小的文件（0=不设上限） |
| `localImport` | bool | `true` | 透明模式下，仅存在于本机的文件（聊天附件、浏览器截图）在第一次被标准 `read`/`read_image` 引用时导入远端工作区 |
| `localImportRoots` | string[] | `[]` | 允许按需导入的本机目录；空=使用 `$DSH_HOME/attachments` 与 `$DSH_HOME/browser-control` |
| `maxImportBytes` | int | 52428800 | 单个本机文件的导入大小上限（0=不设上限） |
| `hostKeyMode` | string | `accept-new` | 主机指纹策略：`accept-new`（首次信任）、`verify`（拒绝未知主机）、`off`（跳过校验） |
| `useAgent` | bool | `false` | 用 OpenSSH agent（`SSH_AUTH_SOCK`）认证 |
| `keyboardInteractive` | bool | `false` | 允许 keyboard-interactive 认证（OTP/MFA）并复用配置的密码 |
| `backend` | string | `native` | SSH 传输后端（issue #51）。`native`=内置 ssh2（密码/私钥/agent/动态码）；`openssh`=**调用本机 `ssh` 命令**，因此支持 GSSAPI/Kerberos（`kinit` 后免密）以及 `ProxyCommand`、`PKCS11Provider`、`Match` 等 OpenSSH 专有特性。**可按机器单独设置**。代价：每条命令新建一次连接（比 native 慢）；SFTP 仍复用单条长连接。主机名会被**原样**交给 ssh（`~/.ssh/config` 是配置唯一来源），主机密钥也由 ssh 用你自己的 `known_hosts` 校验 |
| `sshBinary` | string | `''` | `openssh` 后端调用的 `ssh` 可执行文件（留空=用 PATH 里的 `ssh`） |
| `proxy` | object | — | 跳板机：`{ host, port?, username?, password?, privateKeyPath? }`；语义是「在跳板机上连目标 host:port」，所以也能用来连跳板机上 docker 容器的 sshd（见「常见问题」里的 issue #56） |
| `autoPush` | bool | `false` | 镜像内文件被编辑后自动推回远端（watcher，带防抖） |
| `auditLog` | bool | `true` | 把执行的命令追加到 `$DSH_HOME/remote-workspaces/audit.log` |
| `encoding` | string | `utf-8` | 远程文件读写的文本编码（如 `gbk`） |
| `fileReference` | bool | `true` | 远程 `@` 补全：远程会话的 `@` 列出**远端**目录树（issue #39）；关闭则只有本地镜像 |
| `fileReferenceMaxResults` | int | `20` | 一次 `@` 查询最多返回多少候选 |
| `fileReferenceMaxEntries` | int | `3000` | 一棵远程工作区索引最多保留多少条目 |
| `fileReferenceExcludedDirectories` | string[] | `[.git, node_modules, dist, build, out, coverage, target, .next, .nuxt, .turbo, .venv, __pycache__, .pytest_cache, .mypy_cache, .gradle]` | 远程 `@` 遍历跳过的目录名 |
| `fileReferenceTimeoutMs` | int | `4000` | 一次远程索引遍历的墙钟预算（超时用已扫到的部分结果，不让光标等） |
| `searchTimeoutMs` | int | `60000` | `rw_search` 的协作式预算（ms）：既作为工具声明的 `timeoutMs` 交给 DSH 的 timeout-policy，也是搜索自身的墙钟上限；到点返回部分结果并标 `TRUNCATED`（issue #44）。 |
| `searchMaxEntries` | int | `50000` | `rw_search` 在返回部分结果前最多扫描多少个文件。 |
| `updateMode` | string | `auto` | 自更新模式：`auto`=加载时及每 6 小时检查并自动应用、`manual`=仅在手动检查时查、`off`=完全不查。**0.8.27 起默认 `auto`**——之所以现在才安全，是因为 0.8.24 补上了宿主半热切换 |
| `updateCheckIntervalMs` | int | 21600000（6h） | `auto` 模式检查 npm 的间隔（下限 60000） |
| `updateAutoReload` | bool | `true` | 更新落地后自动热切换宿主半；`false` 则留到下次启动，设置页会显示 `pendingReload` |
| `webAttachPortStart` | int | `3088` | 「远程 DSH 界面」在本机监听的起始端口（占用则顺延，仅监听 127.0.0.1） |
| `webAttachCommand` | string | `dsh` | 在远端启动 `dsh web` 用的命令；远端 `dsh` 不在 SSH 登录 PATH 时改这里（也可按机器在设置页「高级」里单独设，机器级优先） |
| `webAttachDshHome` | string | `''` | 远端启动时导出的 `DSH_HOME`；留空则复用远端用户自己的 harness home |
| `webAttachWaitSeconds` | int | `45` | 等待远端 `dsh web` 打印启动令牌的秒数 |
| `webInstallPrefix` | string | `''` | 自动部署装到远端的哪个目录；留空用 `$HOME/.dsh-remote/dsh`（不写系统目录、不改 PATH） |
| `webInstallVersion` | string | `0.1.5-rc.2` | 自动部署安装的 dsh 版本；默认值是第一个在 Linux 上能启动 web 的版本 |
| `webInstallRegistry` | string | `''` | 安装用的 npm 源；**留空沿用远端自己的配置**，不会覆盖内网镜像 |
| `executionMode` | string | `legacy` | 标准 DSH 工具执行模式：`legacy` 保持本地镜像 + `rw_*`；实验性的 `transparent` 只在 remote mirror Agent 上将标准工具路由到远端。transparent profile **不注册任何 `rw_*` 模型工具**（本地 Agent 也不暴露）；连接和选目录走 Settings UI。`read`/`write`/`edit` 直接作用于服务器主机文件系统：workspace 内路径按远端 root 解析，`write`/`edit` 受远端 workspace root 限制且改已有文件需先读，冲突返回 `FS_STALE_VERSION`；超出 workspace 的路径仅在命中服务器 skill 目录（`SKILL.md` 及其引用文件，≤128 KiB UTF-8）时由 `read` 只读返回。`read_image` 需 image-capable 模型和部署附件策略，原图传输上限 32 MiB；`glob`/`grep` 使用服务器 PATH 中的 `rg` 并保留 DSH caps/spill，无 rg 时 fail-closed。`bash` **直接以 SSH 登录用户在服务器主机上执行**，继承该账号的普通环境与权限，不注入 bwrap 或任何沙箱；helper 握手的依赖预检只需 `rg`。background、per-call escalation、PTY 未支持；SSH 断线后会话在下一步自动重连并补装远端工具覆盖，断线瞬间的调用不重放、MCP 传输需重建 Agent；每条输出流最多 256 KiB 且不在本机 spill。transparent 模式还会在标准文件操作前用 helper 刷新 root 和最多 16 层祖先的 `AGENTS.md`/`CLAUDE.md`（每文件上限 256 KiB；工作区内的软链照常解析（如 `CLAUDE.md -> AGENTS.md`，同一文件的别名只注入一次），解析到工作区外的软链只跳过该文件并告警一次、不再中断本轮），由 DSH core 唯一注入；`transparentLocalMirror=merge` 时，镜像里存在、远端没有的指令文件不再算冲突：工作区根与祖先链上的这类文件由 core 正常注入（子目录里的同样保留，且不再阻断远端文件操作），同路径以远端内容为准（覆盖镜像里的未跟踪副本并在日志中提示一次）。Skills 默认全部来自服务器：项目 `.dsh/skills`、`.agents/skills`，以及用户级 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）与 `$AGENTS_HOME/skills`（默认 `~/.agents/skills`）；本机用户级 skill 始终被 scope 内屏蔽。`transparentLocalMirror` 为 `merge`（默认）时，只存在于本地镜像 `~/.dsh/remote-workspaces/` 的 skill 也会加载，并与远端按名字去重（远端同名优先）；`remote-only` 则只加载远端技能。MCP 服务器从服务器自己的配置（`$DSH_HOME/mcp.json`、项目 `.mcp.json`、`.dsh/mcp.json`）发现，通过 SSH 在服务器上启动 stdio 服务，Agent 内继承的本地 MCP 工具/资源被屏蔽；HTTP/SSE server 暂不支持。仅存在于本机的文件（聊天附件、`browser_screenshot` 截图）在第一次被标准 `read`/`read_image` 引用时被导入远端 `<ws>/.dsh-remote/imports/<sha256>/…`，这两个工具返回的 `path` 就是后续 `bash`/`edit`/`glob`/`grep` 应使用的远端路径；`write`/`edit` 不会修改仅存在于本机的文件。Settings 页只读显示已加载模式；更改需通过 DSH profile 配置并重新加载插件，本页不写入第二份配置。 |
| `transparentLocalMirror` | string | `merge` | 透明模式下本地镜像（`~/.dsh/remote-workspaces/`）是否参与 skill / AGENTS.md 合并：`merge`（默认）=镜像里独有的 skill 与指令文件照常加载，与远端按名字/路径去重（远端优先；同路径的未跟踪本地副本会被远端覆盖，已跟踪但被本地修改的仍按冲突 fail-closed，并提示一次）；`remote-only`=恢复 0.8.54 的纯远端行为。本地用户级 skill 始终不加载。 |
| `localTools` | string | `bootstrap` | 仅在 `legacy` 模式控制本地 session 暴露哪些 `rw_*` 工具（issue #63）：`bootstrap`=只暴露配置闭环 `rw_machines`/`rw_connect`/`rw_pick_workspace`；`none`=不暴露；`all`=旧行为。`transparent` 模式不注册 `rw_*`，此项无效。|

> 权威清单是 `lib/index.js` 里的 `Config` schema，本表与之一致。

## 常见问题 / 排查

**内置文件工具没有读到最新远端文件** — 默认 `executionMode=legacy` 时，内置工具看到的是本地镜像，须先用 `rw_sync` 下载。实验性的 `executionMode=transparent` 会让远端 mirror session 的标准 `read`/`write`/`edit`/`read_image`/`glob`/`grep`/`bash` 直接作用于服务器：`read` 可以直接读服务器上的 skill 目录和引用文件；`bash` 以 SSH 登录用户的普通权限在主机上执行，**不经过 bwrap 或其它沙箱**。`glob`/`grep` 要求服务器 PATH 中有 `rg`，并保留 DSH caps/spill；缺少 `rg` 时 fail-closed。`read_image` 受模型能力、部署附件限制和 32 MiB helper 上限约束。后台任务、单次权限 escalation、PTY、本地全量输出 spill 尚不支持；SSH 断线后下一步会自动重连并补装工具覆盖，但断线瞬间的调用不重放、MCP 传输需重建 Agent；当前最大收集 256 KiB/stream。仍建议生产保持 `legacy`，除非接受该远端 profile 直接以登录用户身份操作服务器的安全属性。

**远端项目 skills 和插件声明如何处理？** transparent Agent 从服务器发现技能：项目 `.dsh/skills`、`.agents/skills`，以及用户级 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）和 `$AGENTS_HOME/skills`（默认 `~/.agents/skills`），正文按 hash/version 从服务器读取；本机 `$DSH_HOME/remote-project-config/<workspace-hash>/manifest.json` 只存元数据，不存 skill 正文。每个 Agent 的 scope 隔离技能。`transparentLocalMirror=merge`（默认）时，只存在于本地镜像 `~/.dsh/remote-workspaces/` 的技能照常加载，并与远端按名字去重（远端同名优先，远端没有的镜像技能才生效）；远端已不存在的镜像残留、以及本地用户级技能仍被禁用。`remote-only` 则恢复纯远端行为。项目插件声明只记为“不支持”：当前 DSH 从 `$DSH_HOME/profiles/<profile>` 加载插件，不会复制或执行远端 `package.json`、`node_modules`、`cordis.patch.yml`。远端 `.env` / `.credentials.yaml` 不纳入项目配置。**MCP** 由服务器配置驱动（`$DSH_HOME/mcp.json`、项目 `.mcp.json`、`.dsh/mcp.json`，后者覆盖前者，`disabled: true` 表示移除），stdio server 通过 SSH 在服务器上启动，工具名形如 `mcp__<server>__<tool>`；本机继承的 MCP 工具与资源在远端 Agent 内被屏蔽，HTTP/SSE server 暂不支持。

**远程会话里的文件链接打不开**（issue #55）—— 已修。链接被点开时 harness 会把它变成
`dsh-resource://file/session/<会话>/<路径>`，然后交给内置的文本预览去读；而那个预览读的是**本机**
文件系统，远程会话的 cwd 是**本地镜像目录**（`rw_sync` 之前是空的），所以打开只会失败。
插件现在注册了一个更高优先级的地址处理器，把这个地址按远程主机解析后用 SFTP 打开（和侧栏「远程文件」同一个编辑器）。
安全边界是保守的：只有当该会话的 cwd **确实落在某个镜像目录里**、且镜像表已加载时才接管，
本地会话与页面刚加载的那一瞬间仍然走内置预览 —— 不会把本地文件误当成远程文件。
两个仍然开不了的情况会给出明确提示而不是空白页：链接指向的是**绝对**远端路径之外无法映射的地址，
或该会话的工作区不是一个远程镜像目录。
两个例外（0.8.52+）：`.md`/`.markdown` 链接**不被接管**、交还内置 Markdown 渲染（issue #64——远程编辑器只能看
源码，对 Markdown 是净损失；它读本地镜像副本，要最新内容先 `rw_sync`）；图片文件则在内置链路与远程链路
都谈不上「渲染」，侧栏远程文件树现在直接内联显示 png/jpg/gif/webp/svg/bmp（issue #66，>2MB 退回下载按钮）。

**SFTP 操作一旦超时就永远卡死**（issue #65）—— 已修（0.8.52+）。旧版里一次撞满 20s 超时的 SFTP 操作会把
该机器在本进程内的全部 SFTP 工具拖到永久超时（`rw_exec` 却正常），只能断连重连。现在超时即置死该通道、
后续请求立即失败；native 后端连续两次超时会废弃整条连接重新握手，openssh 后端会重建 sftp 子进程——
一次网络抖动不再需要用「断开重连」来收场。顺带，`rw_edit` 改成了「临时文件 + rename」原子写，
写一半超时不会再把远端文件截成 0 字节，原文件的权限位也会保留。

**机器换了 IP / 用户名，工作区要全部重建吗？**（issue #67）—— 不用（0.8.52+）。在设置页编辑该机器的新
地址并保存，或 `rw_connect(machineId=…, host=…, username=…, port=…)` 同传新地址：该机器名下所有工作区
镜像会**原地重绑**（改写镜像的 `.dsh-remote-meta.json`），本地内容保留、无需重新同步，保存后会提示重绑了
几个镜像。镜像目录名不会跟着改（活 session 的 cwd 在其中），目录名只是显示标签、不影响连接。

**远程会话看不到工作区的 AGENTS.md**（issue #68）—— 已修（0.8.52+）。核心的指令加载只认本地文件系统，
而远程会话的 cwd 是本地镜像，远端仓库的 AGENTS.md 以前永远进不了模型上下文。现在 `rw_pick_workspace`
成功时会对远程工作区做浅扫（根 + 向下 ≤2 层，只匹配 `AGENTS.md`/`CLAUDE.md`），把命中的文件按三向安全
规则同步进本地镜像（根级文件由此进入核心自己的注入链路，与本地会话一致），并把路径+标题索引渲染进
system prompt，提示模型编辑前用 `rw_read_file` 阅读嵌套层的指令。全树递归扫描与插件侧全文注入都**刻意
不做**（前者会扫穿多项目根目录，后者会与核心的注入管线并行打架）。

**读了远程子目录的文件，子目录里的 AGENTS.md 会自动进上下文吗？**（issue #71）—— 会（0.8.53+）。
#68 只修了静态部分（工作区浅扫 + 索引行）；动态部分当时还断着，原因是核心的增量注入只认
`read`/`write`/`edit` 且只认 `file_path` 参数，而 `rw_read_file` 名字和参数都对不上，且它做作用域
扩展时用的是**本地**路径——远程绝对路径映射不到镜像 cwd，三个断点任一都足以让注入永不发生。
现在插件自己在 `tools/result` 里接 `rw_*` 文件触碰，取「被访问目录 → 工作区根」的**整条目录链**
（不是最近一层，与本地会话一致：读 `a/b/c.ts` 会同时收 `a/AGENTS.md` 和 `a/b/AGENTS.md`），逐层
`stat` 后把当前内容合成**一条** user message 注入。几个关键边界：cwd 自己那层不重扫（核心 baseline
已覆盖，所以读工作区根下的文件不触发任何额外扫描）；按内容摘要 per-session 去重，同内容只注入一次；
远端修改后下次触碰即重新注入；注入过的文件被删除会发一条「已移除」提示；单次注入有 16 KB 预算；
机器离线时整条链路静默降级，既不挂工具调用也不挂 prompt 组装。注入消息用插件自己的
`source.kind`（`dsh-remote-instructions`），核心的状态机只认领它自己的 `agent-instructions`，两条
注入路径不会互相打架。transparent 模式走另一条边界：标准文件操作前由持久 helper 读取工作区根与最多 16 层祖先中的 `AGENTS.md`/`CLAUDE.md`（单文件最多 256 KiB；工作区内的软链照常解析，解析到工作区外的软链跳过该文件并告警一次），安全更新本地镜像后由 DSH core 唯一注入；本地副本冲突时远端操作 fail-closed。

**`rw_exec` 能像内置 shell 那样自定义超时/取消/转后台吗？**（issue #70）—— 能（0.8.53+）。
底层 `pool.exec` 本来就支持 `timeoutMs` 与 `AbortSignal`，缺的是接线，现在补齐三件事：
① `timeoutMs` 参数（clamp 到 1000–600000，缺省仍用 `commandTimeoutMs`，超时文案打印**实际生效**的值，
不会印错成配置值）；② `exec.signal` 透传给 `pool.exec`——点「停止」会真的 SIGTERM 掉远端进程并立即
返回，不用再等满超时；③ `run_in_background: true` 立即返回 job id（用现成的 `job_output` 读、
`job_kill` 停），以及超时**转后台**而非直接杀（`promoteOnTimeout`，默认开）。后台/转后台依赖核心的
`jobs` 服务；没有该服务的组合（最小嵌入、测试替身）自动退化为只有前台执行——即 0.8.52 的行为，
不会因此加载失败。

**远程会话里的终端还是本机的**（issue #55）—— 这是**设计如此，插件改不了**，但有等效方案。
DSH 的侧栏终端是核心功能：它的 PTY 来自**全局唯一**的 `subprocess` 服务，cwd 取会话自己的
工作区目录（远程会话就是本地镜像），插件既不能替换那个服务、也不能把核心终端重定向到 SSH。
想要「真正的远程终端」，用**「远程 DSH 界面」**（见上文）：它在本机浏览器里打开**远端机器自己**的
DSH，那个界面里的终端就跑在远端主机上，零额外配置。只想偶尔跑一条远程命令则用 `rw_exec`
（要交互式 PTY 就加 `pty: true`）。

**主机指纹变了** —— `/remote forget-key`（或设置页 → 机器 → 重新信任）。

**连接报「认证失败」** —— 检查用户名/密码/私钥路径；加密私钥要填 Passphrase；需要动态码时勾选 keyboard-interactive。

**连不上内网机器** —— 填「跳板机」主机（也可先把跳板机本身配成一台机器）。

**能不能拿远程主机上的 docker 容器当工作空间？**（issue #56）—— 能，**不需要改插件**；
插件对容器没有任何专门代码，但下面两条既有配置已经完整覆盖这个需求。请按容器**有没有对外暴露端口**二选一：

- **A：容器把 sshd 端口映射出来了**（例如 `docker run -p 127.0.0.1:2222:22 …`）—— 纯「跳板机」配置：
  Host 填 `127.0.0.1`、Port 填 `2222`、用户/私钥填容器里的，再把「跳板机」主机填**那台远程主机**。
  为什么这样文件就能落到容器里：`proxy` 的语义是「**在跳板机上**连 `<host>:<port>`」
  （`lib/pool.js` 的 `pclient.forwardOut(...this.config.host, this.config.port...)`），
  拿到的通道会被当成主连接自己的 transport（`opts.sock`），于是 SFTP 走的是**容器自己的 sshd** ⇒
  `rw_list_dir`/`rw_read_file`/`rw_write_file`/`rw_sync` 全部读写的都是容器内的文件。
  命令行等价写法：`rw_connect(host="127.0.0.1", port=2222, username="<容器用户>", privateKeyPath="<私钥>")`。
  要求：远程主机的 sshd 允许转发（`AllowTcpForwarding yes`，默认就是）。
- **B：容器没有暴露端口** —— 纯 `~/.ssh/config` + 系统 OpenSSH 后端，在**本机** `~/.ssh/config` 写：

```sshconfig
Host devbox
    HostName devbox.invalid
    User dev
    IdentityFile ~/.ssh/id_ed25519
    ProxyCommand ssh <远程主机> docker exec -i <容器名> sh -c 'exec socat - TCP:127.0.0.1:22'
```

  然后 `rw_connect(host="devbox", useSshConfig=true, backend="openssh")`。
  为什么 `exec` 和文件操作**都会**进容器：`openssh` 后端把别名原样交给 `ssh`，
  自己**从不**生成 `ProxyCommand`（`lib/openssh.js` 明确不传，就是为了让 `~/.ssh/config` 说了算），
  而 `ssh -s <目标> sftp` 与 `ssh -- <目标> <命令>` 走的是同一条流 ⇒ 两者都穿过这个 ProxyCommand。
  要求：容器里有 sshd，且有 `socat`（或用支持 stdio 的 `nc`）。
  ⚠️ **Windows 上有个坑**：POSIX OpenSSH 会把 `ProxyCommand` 交给 shell 展开，**Windows 自带的 OpenSSH 9.5 不会**
  （实测它把整串按字面当成 argv）。所以在 Windows 跑本插件时，要么把 `ProxyCommand` 写成
  不含 shell 元字符的单条命令，要么把「ssh 路径」指向 Git Bash 的 `ssh.exe`。
  （另：`docker exec -i` 传二进制是否逐字节无损，我这边没有 docker 环境验证过，B 方案建议先用小文件试。）

**企业机器只允许 GSSAPI/Kerberos（`kinit` 后 `ssh` 能进，插件进不去）** —— 在设置 → 远程工作区 → 高级配置里把「连接后端」改成 **`openssh`**（调用本机 `ssh`），并勾选「使用 ssh_config 别名」，Host 填 `~/.ssh/config` 里那个**别名**（不是 IP）。这样登录由本机 ssh 用你的 Kerberos 票据完成，且 `ProxyCommand`、`GSSAPIAuthentication` 等全部照 `~/.ssh/config` 生效 —— **配置只有 `~/.ssh/config` 一个来源**（issue #50/#51）。命令行等价写法：`rw_connect(host="<别名>", useSshConfig=true, backend="openssh")`。

**`rw_sync`/`rw_push` 报冲突** —— 两边都改过的文件会被跳过并列出（绝不静默覆盖）；手动合并后重试，或用 `force=true` 以一边为准。

**Windows 远程** —— 全部走 SFTP，不依赖 POSIX shell；中文文件用 `encoding=gbk`。

**镜像里缺目录** — 默认 ignore 会跳过 `.git`/`node_modules` 等，也会双向排除 `.env*`（含 `.env.example`）、`.ssh`/云凭据目录、私钥后缀、`.npmrc`/`.netrc` 和 Terraform state；这是保守安全默认。用户规则只追加，不支持 `!` 反向包含。新规则不会自动删除本地镜像或远端里已有的文件；先检查副本，再分别手动清理不需要的数据。可在 `$DSH_HOME/remote-workspaces/.dsh-remote-ignore` 继续追加忽略规则（受支持的 gitignore 子集）。

**保存远程文件报 409** —— 打开后远端已被改动，重新读取再编辑。

**密码怎么加密保存** —— 勾选「加密保存密码」：macOS 钥匙串 / Windows DPAPI / Linux secret-tool（libsecret）；后端不可用时回退明文。

**升级后插件整个不见了** —— DSH 兼容性判定丢弃了 bundle，升到 **0.8.29+** 即可（见上文「DSH 版本兼容性」）。

**「远程 DSH 界面」连不上/一直转圈** —— 先确认那台机器上的 `dsh web` **本身**能起来。
两个已知坑（插件会在报错里直接点出来）：
① **dsh 0.1.0-rc.6 在 Linux 上无法启动 web**——它依赖的 `node-pty@1.1.0` 只带了
macOS/Windows 的预编译产物，**没有 `linux-x64`**，会报 `Failed to load native module: pty.node`。
升到 0.1.5-rc.2+ 即可（其 `node-pty@1.2.0-beta.15` 带 Linux 预编译）。
② **dsh 0.1.0-rc.6 不认识 `--no-open`**（该 flag 是后加的）；插件会自动去掉它重试一次，无需你处理。
如果远端 `dsh` 不在 SSH 登录 PATH 里（例如装在私有前缀），用 `webAttachCommand` 指向它的绝对路径。

## 安全提醒

把凭据交给插件等于允许 Agent 以你的用户身份在该主机执行 **shell 命令**——只添加可信机器。密码存在本机文件（或钥匙串），请当作敏感数据。开启 `auditLog` 时每条命令都会记入审计日志。

## License

MIT

## 参与贡献

欢迎贡献，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。使用问题、环境配置、「支持 XX 吗」这类讨论请走 [讨论区](https://github.com/flymysql/dsh-remote/discussions)；可复现的缺陷请提 [Issue](https://github.com/flymysql/dsh-remote/issues)。

感谢以下已合并 PR 的贡献者：

[@dahaipeng](https://github.com/dahaipeng) (#31) ·
[@YiHui-Liu](https://github.com/YiHui-Liu) (#28) ·
[@nekomona](https://github.com/nekomona) (#24) ·
[@zhz1667](https://github.com/zhz1667) (#43) ·
[FoolishWiser](https://github.com/FoolishWiser) (#17) ·
[@jace1cch](https://github.com/jace1cch) (#16) ·
[@Minggle](https://github.com/Minggle) (#10) ·
[4FMTWRV](https://github.com/4FMTWRV) (#6) ·
[glzhangzhi](https://github.com/glzhangzhi)（per-session SSH 连接池修复）

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。
