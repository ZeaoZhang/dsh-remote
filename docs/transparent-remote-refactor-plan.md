# dsh-remote 透明远端工作区重构计划

状态：实施中。P1 已有 native/OpenSSH 持久 duplex、JSONL multiplex 和 POSIX helper，支持 read/write/edit/read_image/glob/grep 及有限前台 Bash。P0 已加入 opt-in `executionMode: transparent`：mirror-bound Agent 使用同名 scoped 文件工具；native glob/grep 通过可卸载的 subprocess bridge 在远端执行，保留 DSH tool identity/caps/spill；bash 通过 DSH resolved ShellSpec 直接以 SSH 登录用户在远端主机上执行（不再应用 bwrap/沙箱）；所有成功文件操作发送 DSH observation/intent 事件；不支持的能力 fail-closed。legacy 仍是默认。后台任务重连、PTY、项目配置同步、UI、真实 Linux/bwrap SSH 验收和跨版本兼容均未完成。

## 1. 目标与范围

1. 模型调用、会话和界面保留在本地 DSH。
2. 远端项目初始化时，将项目 DSH 配置、skills、plugin 声明、AGENTS.md 等同步到本地项目配置目录，保留来源和作用范围。
3. 模型使用标准工具名称和参数，新模式不暴露 rw_*；连接、选目录和初始化由设置页、工作区选择器及宿主命令完成。
4. read/write/edit/read_image/glob/grep/bash 操作同一远端项目，返回结果、差异、输出事件和退出码。
5. 复用持久 SSH 连接及长期 helper 通道，不为每次工具调用重新连接或创建 exec channel。
6. 后台任务可取消、断线后可重新附着；多个远端会话和本地会话互不串机。

“远端执行”覆盖项目文件、命令、搜索和终端。模型请求、会话编排、用户提问、任务清单等控制能力仍在本地。绕过 DSH 执行接口的第三方插件/MCP 不能自动远端化，必须检测并标记支持范围。

## 2. 当前基础与复用

| 现有文件 | 处理方向 |
| --- | --- |
| lib/index.js | 从 rw_* 注册和大入口逐步拆分为装配、兼容和 UI 路由 |
| lib/pool.js、lib/openssh.js | 保留认证后端，扩展持久 duplex 传输 |
| lib/binding.js | 将 cwd→镜像映射升级为不可变执行目标，兼容旧元数据 |
| lib/registry.js、lib/credential.js、lib/hostkey.js、lib/sshconfig.js | 复用主机、凭据、指纹和 SSH 配置处理 |
| lib/sync.js | 保留 legacy 业务镜像同步；新模式只同步项目配置 |
| lib/instructions.js、lib/instructions-dynamic.js、lib/file-reference.js | 接入统一配置索引和远端路径解析 |
| lib/client.js、lib/routes-fs.js | 复用设置、选择器和文件展示入口 |
| lib/exec-job.js、lib/tasks.js | 接入标准任务契约，避免两套模型可见任务系统 |
| lib/remote-shell.js | 新模式接统一远端进程层，旧模式保持兼容 |

## 3. 目标模块

以下为拟新增/拆分模块，实际文件名可按实施需要调整。

| 模块 | 职责 |
| --- | --- |
| lib/runtime/binding.js | 工作区、会话执行目标和子 Agent 继承 |
| lib/runtime/transport.js | native/openssh 持久传输与生命周期 |
| lib/runtime/protocol.js | 分帧、版本、请求映射、取消、事件和背压 |
| lib/runtime/client.js | helper 启动、连接、能力协商、重新附着 |
| lib/runtime/bootstrap.js | 运行时探测、私有部署和版本校验 |
| lib/runtime/helper/ | 远端文件、搜索、进程、PTY 与持久任务 |
| lib/adapters/fs.js | 满足 DSH FileSystem 契约的远端 Adapter |
| lib/adapters/subprocess.js | 满足 SubprocessRuntime 契约的远端 Adapter |
| lib/adapters/shell.js | 仅在现有 shell 无法组合远端 subprocess 时实现 |
| lib/project-config/ | 配置清单、快照、增量同步、插件解析和资源映射 |
| lib/runtime/mount.js | 按会话装配执行接口和兼容检测 |

优先复用标准工具实现，替换执行层。不能仅替换 ctx.fs：当前 glob/grep 通过 ctx.subprocess 启动搜索程序。

## 4. 执行目标与路径规则

执行目标包含 workspaceId、machineId、connectionRevision、remoteRoot、remotePlatform、localConfigRoot；凭据不进入工作区元数据。

- 已派发请求固定执行目标，设置页切机或更新配置不改变运行中请求。
- 连接可复用，但每个请求明确携带工作区和 cwd。
- 连接池身份涵盖认证配置引用、代理、后端和配置 revision，避免只按 user@host:port 错误复用。
- 本地占位/配置目录满足宿主要求；项目工具路径统一映射为远端路径。
- 宿主路径、远端路径、附件和 skill 资源显式区分，不依赖字符串替换猜测。
- 远端业务文件为唯一事实来源，本地业务镜像不作为自动回退。
- 离线、损坏绑定、缺失元数据均明确报错，禁止回退本地执行。

## 5. 配置同步

初始化构建远端配置清单，增量拉取后原子发布完整快照，失败不发布半成品。

清单记录路径、hash、来源、类型、作用域和快照版本；设置文件大小、数量、遍历和链接限制。根指令先同步；嵌套 AGENTS.md 保持目录层级，通过有界索引及访问目录时的祖先链刷新避免遍历整个大型项目。

| 内容 | 加载规则 |
| --- | --- |
| AGENTS.md 及宿主支持的指令文件 | 保持目录作用域与来源 |
| Skills | 同步说明和必要资源；随附脚本默认在远端原位置执行，映射展示路径 |
| 项目 DSH 配置 | 验证实际配置入口/合并规则，再转换受支持字段 |
| Plugins | 同步声明、版本和配置，本地解析依赖和兼容性；不复制 node_modules、原生二进制或运行状态 |
| 用户级配置 | 单独显式选择继承，默认项目范围 |
| 模型与 SSH 凭据 | 排除在项目同步清单之外 |

本地覆盖单独保存，不改生成快照；优先级使用 DSH 实际契约并展示来源。打开工作区时检查，新轮次做有界刷新；同一轮使用稳定快照。插件变更需要重载/重启时显示 pending。

插件安装限定项目或隔离 profile；宿主无法隔离加载时明确报告，不静默污染全局。插件若直接调用本地 Node fs/child_process 或本地 MCP，列为不支持透明路由，不能误宣称已远端化。

## 6. 持久传输与 helper

- native：复用 SSH Client 和一个长期 helper channel。
- openssh：一个长期 SSH 子进程承载协议，不按工具调用重建 ssh；额外通道的 ControlMaster 支持另行按平台验证。
- 长度分帧结构化消息，区分 request/response/event/cancel/heartbeat；stdout 专用于协议，诊断走 stderr。
- 请求携带协议版本、requestId、workspaceId；任务有稳定 taskId，输出事件有序号，重连按 cursor 补取。
- 支持并发在途请求、背压、消息/缓冲上限；大输出不能阻塞取消和文件请求。大文件分块，必要时使用独立数据通道。
- 探测远端 Node，版本要求由实际依赖确定；缺少运行时时返回初始化诊断，不静默执行任意安装脚本。
- helper 部署到用户私有目录，以内容 hash 和协议版本隔离，校验后原子切换，新旧会话可并存。
- 首版验收 Linux/macOS POSIX；Windows 旧能力留在 legacy，新模式未实现则明确提示。

helper 独立于 SSH 通道存活，通过权限受限的本地 IPC（POSIX 优先 Unix socket）供 attach bridge 访问，不开放网络监听。

- 每个远端用户/helper 版本管理实例，任务与输出保存在私有目录。
- 区分断开传输、取消任务、关闭会话、卸载插件，断开不等于取消。
- 状态包含 queued/running/completed/failed/cancelled/unknown；断线不伪装为成功或失败。
- 重连核验实例、查询任务、补取输出；helper 重启后无法证明存活的任务标记 unknown。
- 不承诺任意崩溃下的 exactly-once。已派发未确认的写入/命令不自动重放，先查操作状态，无法确认则报告不确定。
- 设置日志容量、保留策略、空闲退出和清理入口；运行中任务阻止空闲退出。

## 7. 标准工具语义

- 文件：保持 canonical identity、UTF-8/二进制、分段读取、版本观察、FS_STALE_VERSION、原子修改与链接语义。
- 并发修改：验证实际能提供的提交保证。独立 stat+rename 不是相对任意外部写入的严格 CAS，不能据此宣称完整保证；若宿主要求更强，须评估并明确限制。
- 搜索：远端 subprocess 优先复用宿主固定参数逻辑，探测 rg 版本；缺失时提供明确部署路径，替代算法需说明差异。
- 普通 bash：每次独立进程、显式 cwd/env；持久通道不引入隐式共享 cd/export。
- 进程：stdout/stderr/exit/signal、超时、取消进程树、后台任务和标准 jobs 完整适配。
- PTY：输入、resize、signal 独立处理，能力不足则明确禁用。
- Sandbox：在远端真实执行限制，Linux/macOS 分别探测；不宣称本地 workspace-write 自动限制服务器进程。当前 Node helper 的内容读取使用 `O_NOFOLLOW` 和打开后设备/inode 复核，拒绝静态 traversal/symlink escape 并缩小 read TOCTOU；写入仍以路径 rename 提交，父目录复核不能关闭最终 rename 的并发竞态。透明模式不是对抗共享工作区恶意进程的安全边界。
- 环境：使用远端 PATH/HOME，清洗宿主密钥与 DSH_*，显式传递所需会话事实。
- 产物：远端 spill、图片、附件、present 和下载显式桥接为本地可展示资源，保留来源。

## 8. 实施阶段与验收

### P0：宿主契约与装配验证

核对 0.2.1-rc.3 的 fs/subprocess/shell、scope、jobs、workspace、skills、plugin、sandbox；建立 fake remote 最小实验。

退出标准：本阶段尚未完成。当前实现 read/write/edit/read_image 的同名 scoped adapter；glob/grep 保留原 DSH tool object，经 subprocess bridge 远端运行；bash fail-closed。尚无多远端会话、子 Agent、PTY 和真实 SSH 集成验收。

DSH 0.2.1-rc.3 的 `agent/created` payload 为 `{ agent, source, signal? }`，各 Agent 有独立 scope，子 Agent 不可假定继承父 scope。透明模式逐个 Agent 检查 mirror binding，再通过 `agent.ctx.tools` 安装同名 adapter，并限制该 Agent 的 rw_*；每次调用从 `workingDirectory.ensure(agent, signal)` 取动态 cwd。adapter 保留原 schema/renderer，文件路径只允许映射到 remoteRoot。远端 read/write/edit 使用内容版本 CAS 并发出 `fs/observed`，修改前经过 `fs/write-intent`/`fs/edit-intent`；未知的非空 intent 和 sandbox escalation 均拒绝。read_image 通过 capability-gated bounded chunks 转成 DSH attachment；图片链接/UI 映射仍待验收。宿主的本地审批不能替代远端 sandbox。

远端路径映射、会话隔离和 fail-closed 已有 fake/unit tests；这不等于 P0 退出验收。仍须验证两个远端 Agent、本地 Agent、子 Agent、PTC、宿主 sandbox 与真实 DSH tool lifecycle。缺少必要 scope/service/binding 时创建失败或操作报错，不能回落到本地执行。

交付：契约矩阵、最小实验、内部接口、支持版本。通过后再大规模迁移；必要上游改动先给出明确最小范围。

### P1：绑定和持久协议

实现新绑定、连接身份、两后端持久传输、分帧、握手、心跳、并发和取消。

当前部分完成：native 复用 SSH Client 的长期 exec channel；OpenSSH 复用长期 ssh 子进程；JSONL RPC 有 requestId、并发、取消、超时、断连不重放与协议校验。fake helper 测试连续 100 次请求复用一个 helper channel；真实 SSH 与平台矩阵未验证。

验收：fake transport 下连续 100 次请求复用 helper channel，并发响应正确关联；取消、半包、断连和协议错误有确定结果。大输出期间的背压和真实 SSH 故障注入仍待完成。

### P2：文件和搜索 Adapter

当前 POSIX helper 实现 bounded read/write/edit、sha256 optimistic concurrency、read_image chunk transfer，以及受 argv/路径/output 上限约束的远端 `rg` runner。image bridge 执行 DSH model capability/attachment gates，最多传输 32 MiB，再用 SHA-256 校验并调用 attachments.saveImage。native glob/grep tool object、caps 与 spill hook 保持不变；搜索只经原生 DSH subprocess seam 路由，远端缺少 `rg` 时 fail-closed。真实远端 `rg`、路径解析和并发输出验收仍待完成。

验收尚未完成：需验证真实 DSH fs Target、sandbox、链接语义及远端搜索；helper 的写入 CAS 不代表对任意并发外部写入提供严格原子 compare-and-swap。

### P3：进程、后台任务与 PTY

实现远端 subprocess/shell、独立 helper、任务日志、输出 cursor、标准 jobs、进程树取消和重新附着。

当前 transparent Bash 有 scoped foreground adapter：它用 `ctx.shell.resolve()` 取得 cwd、timeout 与 stdout cap，不调用本机 `ctx.shell.execute()`，也不再把桌面端 DSH 文件沙箱策略下推为远端隔离（`resolveBashSpec` 固定 `danger-full-access`）。helper 仅执行 POSIX Bash，以 SSH 登录用户的普通环境与权限在主机上运行，`process.env` 随之继承；工作目录若落在本地 mirror 内会映射回远端路径，否则按远端绝对路径校验。bwrap 相关分支仍保留在 helper 内但 transparent 路径不再使用；项目 skill 目录与 skill 引用文件通过 `project_skill_read{resource:true}` 以只读方式提供，用户级 skill 根为 `$DSH_HOME/skills` 与 `$AGENTS_HOME/skills`；MCP 由服务器自身配置发现并经 `RemoteMcpStdioTransport` 在服务器上启动。per-call escalation、background/promotion、PTY、任务重连/恢复和本机 spill 尚不支持；每个 stdout/stderr 最多收集 256 KiB。取消/timeout 会对目标进程组发 TERM，再按 grace 发 KILL；bwrap 模式额外使用 PID namespace，danger-full-access 下主动 daemonize 的后代仍可能逃逸。项目 root 与 helper cache 均要求在 writable workspace 外；普通文件/skill/image/read 使用 no-follow descriptor 和设备/inode复核；helper staging、workspace mutation 和最终 rename 仍有路径式 parent TOCTOU。
本地 helper/bridge 单测覆盖 argv、超时、取消和输出限制，但尚未在真实 Linux SSH 主机上验证 bwrap namespace、workspace-write denial 或 DSH 宿主全链路。


验收：cwd/env/退出码正确；后台测试不阻塞读文件；取消只终止目标进程树；断开后任务继续、重连补输出且不重放；helper 崩溃显示 unknown；实测 PTY 输入和 resize。

### P4：项目配置初始化

当前基线：legacy mirror pull/push/auto-push 和默认搜索已排除常见 credential-bearing 名称（`.env*`、SSH/cloud stores、private-key extensions、npm/netrc、Terraform state）；规则按路径匹配、双向生效且不删除历史副本，不能替代内容扫描。DSH 的 `.env` 还是本地凭据输入，不属于可同步配置。

已实现的 P4 子集：
- transparent Agent 在自己的 `ctx.skills` scope 注册项目 provider，只从远端 `.dsh/skills` 和 `.agents/skills` 枚举技能；skill 正文按版本从远端读取，resourceBase 指向远端目录。
- `project_skills_manifest` 有独立路径/凭据检查，不跟随符号链接，最多 64 项、128 KiB/项、2 MiB/次；本机只在 `$DSH_HOME/remote-project-config/<workspace-hash>/manifest.json` 原子保存元数据，不写入业务 mirror，也不缓存正文。
- remote manifest 不可用或 mirror 中存在远端已不存在的 project skill 时，以不允许调用的 Agent-scope 项屏蔽旧本地副本；skills service 的 incomplete snapshot 不会发布半份清单。
- 插件声明只在 manifest 标记为 unsupported。已核验的 DSH 0.2.1-rc.3 Loader 从 `$DSH_HOME/profiles/<profile>/package.json` 与 profile `cordis.patch.yml` 装载，不存在项目级隔离入口；不复制远端依赖、`node_modules` 或可执行 patch，也不自动安装。

- transparent 的标准文件工具在 helper RPC 前读取 workspace root 与最多 16 层祖先中的 `AGENTS.md`/`CLAUDE.md`，单文件上限 256 KiB；helper 先 `realpath` 再逐级 `lstat`：工作区内的软链（如 `CLAUDE.md -> AGENTS.md`）照常读取并按目标去重，解析到工作区外的软链只跳过该文件、不中断本轮，并通过 `O_NOFOLLOW` descriptor 校验后读取。远端删除只移除仍与已同步版本一致的本地副本；本地冲突、越界和安全校验失败均在远端操作前 fail-closed。
- instruction mirror 的三方状态另存 SHA-256；同 size/mtime 但内容不同、本地旧状态缺 hash 或缓存被改动时一律冲突，不覆盖也不删除。读取用 O_NOFOLLOW descriptor 与 inode 校验；写入会复核父目录 identity，但最终 rename 仍有窄 path-based TOCTOU，helper 不是 OS sandbox。

剩余 P4：标准 schema 的项目配置与插件批准需要 DSH host 提供 Agent/project-scoped config overlay 和可信 approval seam。当前 ConfigEditor 只写 profile patch；compatibility exemptions 仅校验 profile 已安装包的精确版本兼容，不是项目执行批准。宿主自己的 user-global context 仍按 DSH 原有规则加载，不代表远端用户配置已同步；在 host seam 到位前，项目插件声明保持诊断-only。

验收：首次打开可在 Agent scope 发现远端项目技能；内容和资源路径始终指向远端；远端更新后生成新版本快照；失败保留最后一份完整元数据但不回退到本地正文；不复制凭据；插件请求仅显示诊断、绝不执行；其他项目和本机用户配置不被改写。

### P5：UI 与旧工作区迁移

实现初始化进度、连接/任务/配置状态、@补全、链接、diff/图片/产物桥接和旧镜像迁移。

当前已在 Settings 展示加载中的 `executionMode` 与能力限制。宿主 plugin Config 由 DSH profile 提供，本仓库没有通用 config-save/reapply API；状态区只读，不创建侧写配置源。

验收：UI 完成选机→选目录→初始化→标准工具任务，无需 rw_*；切换/刷新/重启后归属正确；离线不读本地同名文件。

### P6：集成与发布

Linux/macOS、native/openssh、Web/Desktop 矩阵；故障注入、打包安装、文档与迁移说明。

验收：创建→同步配置→读改搜→运行测试→后台任务→断线恢复→展示产物全流程通过；干净 profile 可安装/启用/卸载；新模式工具清单无 rw_*。

记录初始化耗时、暖调用延迟、连接/channel 数、大输出内存和恢复表现；明确区分 fake transport、真实 SSH 和平台未验证项。

依赖顺序：P0→P1→P2/P3；P4 的清单逻辑可在 P1 后并行，完整加载验收依赖 P2/P3；P5 汇合，P6 完成发布。

## 9. 兼容与迁移

- 开发期提供 legacy/transparent 两种模式，单会话固定模式，不混用执行路径。
- transparent 为最终默认体验；legacy 用于旧平台和迁移，不向新模式暴露 rw_*。
- 旧镜像未推送改动先生成差异报告，不自动覆盖远端或删除本地数据。
- 元数据升级原子写入并兼容读取旧格式，回退前检查格式支持。
- 主机、凭据和转发复用；远端完整 DSH Web 保留为独立功能，不作为透明模式后端。
- 只声明实际验收版本和平台，旧 DSH/Windows 新模式另行扩展。

## 10. 测试与完成定义

保留现有 binding/session-routing/session-fs 防串机测试，hostkey/credential/sshconfig 认证测试，sync legacy 测试和 UI 测试。新增协议/背压、scope 隔离、fs 契约、进程生命周期、断线不重放、helper 重启、配置快照和 plugin 隔离验证。

真实 SSH 使用隔离账户/目录与临时任务，覆盖 native/openssh，分别记录 Linux/macOS 能力。无实测环境则明确未验证。围绕接口行为测试，避免仅复述内部实现。

完成定义：初始化后项目配置正确加载；Agent 以标准工具读改远端、运行测试、管理后台任务；重复调用复用持久通道；断线可查询/附着且不重放；结果在本地正确展示；其他会话不受影响。未支持的 plugin、平台、sandbox 能力均有明确状态，并有实际发布包及真实 SSH 验收证据。
