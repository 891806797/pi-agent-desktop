# 智能体底座：会话管理、失败恢复与 Web 展示集成计划

> 设计已获用户批准并实施，执行分支为 `feat/agent-foundation`，未自动提交。采用 `superpowers:executing-plans` 内联推进及独立评审；最终验证和实施调整见同目录 `2026-11-01-agent-foundation-progress.md`。

**目标：** 用户能管理自己的会话，发现后台需要处理的任务，安全地继续失败任务，并获得与 pi 扩展语义相符的基础 Web 展示。

**架构：** SDK JSONL 继续拥有聊天上下文和工具结果，现有运行检查点负责恢复。新增轻量会话目录与用户级摘要事件，支持管理和后台提醒；聊天正文继续使用现有会话 SSE。扩展 UI 仅桥接适合 Web 的声明式能力。

**技术：** Bun、Elysia、pi-coding-agent、Drizzle + SQLite、React、Zustand、现有 Base UI/sonner。原则上不增加依赖；确需增加时使用 `bun add 包名@latest`，不手写版本。

**依据：** 本文保留批准时的范围和验收依据；实施结果、实际文件与验证方式以执行记录为准，架构说明已同步至 `docs/architecture.md`。

## 1. 范围与优先级

| 功能 | 优先级 | 本轮范围 |
| --- | --- | --- |
| 会话管理 | 非常重要 | 搜索、重命名、归档/取消归档、删除、排序、分页、多页同步 |
| 失败后的恢复操作 | 非常重要 | 识别失败类型，展示可执行操作，多页只能接受一次继续，恢复失败可重试 |
| 后台会话状态与提醒 | 高 | 将“重要且需要完成”纳入本轮；跨会话/项目状态、待处理计数、完成/失败未读、点击定位 |
| 扩展基础 Web 展示 | 高 | notify、status、working 文案、文字 widget、长文本 editor |

认证按用户新约定保留简单方向：新用户名首次登录创建用户，已有用户名验证密码，保留稳定 userId 与数据隔离。本轮不展开用户管理、角色或组织权限，亦不将“用户关系简单”理解成所有用户共用会话。

首次创建只能基于已确认不存在的用户；用户数据读取失败或损坏应报错并保留原文件，不能当成首次登录而覆盖重建。这是简化认证的可靠性边界，不需要用户管理平台。

模型配置表单优先级为中，后续独立完成。本轮不包括会话 fork/rewind、消息全文检索、导出分享、任意扩展代码加载、操作系统通知或多实例部署。

## 2. 现状与方案选择

- `session-registry.ts:listSessions` 每次扫描 JSONL，已有 SDK 名称但前端主要显示首条消息；没有归档、删除和目录变更广播。
- `SidebarPanel.tsx` 只在项目/当前会话变化时加载列表；运行提示主要来自当前会话 store，无法表达其他会话待处理状态。
- 单会话已有完整快照、SSE、审批和重启检查点；继续复用，不为提醒订阅所有后台会话的正文。
- `session-recovery.ts` 已有未知副作用暂停和已完成结果复用；缺少统一可持久化的失败说明、允许操作与用户重试接口。
- `ui-context.ts` 已桥接 select/confirm/input，notify/status/widget/editor 仍为空实现。

推荐：**轻量会话目录 + 每用户一条摘要 SSE + 当前会话正文 SSE**。相比每个会话都开 SSE，连接和消息量更可控；相比轮询，审批提醒更及时且能沿用已有快照对账机制。目录只保存管理信息及可重建摘要，不再存一份聊天消息，也不建设通用任务调度或事件平台。

## 3. 状态和数据归属

| 数据 | 唯一归属与恢复方式 |
| --- | --- |
| 聊天消息、工具结果、原生会话名称 | SDK JSONL；重命名调用公开 `setSessionName`，目录中的名称仅为索引缓存 |
| 模型运行、输入队列/图片、原审批期限、工具执行记录 | 现有 SQLite 运行检查点；保留已实现的恢复语义 |
| 归档、删除生命周期、目录版本、更新时间、未读水位 | 新增 `session_catalog` 表，以 `(userId, sessionId)` 为键 |
| 运行/审批状态和待处理数量 | 从 SDK、ApprovalManager、恢复状态投影；内存实时更新，启动时对账，不作为第二个执行控制源 |
| 重试动作是否已接受 | SQLite `session_actions` 幂等记录；只承担用户恢复操作去重，不存第二份运行状态 |
| 扩展状态与文字 widget | 会话级 UI 状态，页面快照可恢复；服务重启后清除旧运行期展示，由新实例重新发布 |
| 普通输入草稿 | 每页面自己拥有，不因其他页面的扩展调用被覆盖 |

`session_catalog` 至少保存属主、sessionId、workspace、名称/首条摘要缓存、createdAt、updatedAt、archivedAt、lifecycle（normal/deleting/deleted）、revision、noticeVersion、readVersion。目录版本用于管理操作冲突，通知版本用于未读，二者不能混用。

已有 JSONL 首次启动回填，之后按会话事件更新；SDK 名称/历史为准对账索引。空白新会话和检查点尚未生成 JSONL 的会话也必须进入目录，不能只靠扫描文件发现。正常关闭及空闲回收保留目录与历史。

目录扫描、搜索和管理不能为了读取历史而启动 SDK 或恢复模型请求。删除和失败恢复先按属主目录/检查点定位，即使活跃实例不存在也能处理；不能把现有 `requireCtx` 命中当作这些操作的前提。SDK 创建前后均检查删除标记，启动恢复扫描优先完成删除清理，禁止把 deleting 会话先续跑再清理。

持久化归档、删除与未读水位；重启重新派生运行态。不能因目录里上次是“运行中”就假装运行已恢复成功。事件增量缺失时重新获取摘要快照，不能把“连接断开”展示为“任务失败”。

## 4. 会话管理交互和边界

- 侧栏显示名称、最新活动与状态；默认按最新有效活动排序，相同时间使用 sessionId 稳定排序。流式每个 delta 不重新排序。
- 搜索本用户会话名称和首条消息摘要；常规列表按当前项目筛选，可查看归档。先不做全文搜索。
- 重命名保留运行和 URL；去除首尾空白后要求 1–100 字符，由 common 统一校验。SDK 写入成功后更新索引并广播；中途崩溃通过 JSONL 对账修复缓存。
- 归档只整理列表，不停止运行；归档中的待审批/失败仍进入待处理入口，不能被藏住。取消归档恢复常规列表。
- 删除二次确认。运行中的按钮明确为“停止并删除会话”；只删除本会话历史、元信息、检查点及派生数据，不删除项目文件。
- 删除先持久化 `deleting`，阻止新的发送、审批、重试、resume；等待会话变更锁、取消审批、停止 SDK 并清理数据，最后标记 `deleted`。两个页面同时删除保持幂等。
- 跨 JSONL/SQLite 删除不能假装原子操作：失败保留 deleting 和错误，提供重试；重启继续清理，旧 URL 不得重新创建会话。最小删除标记不保存聊天内容。
- 其他页面收到删除事件后解除连接，显示“会话已删除”和返回入口；禁止 404 自动 resume 让它复活。
- 普通目录更新、提醒到达、归档、重命名不修改 URL。只有用户主动打开/新建会话才改变会话坐标；删除当前会话是明确的导航例外，返回同项目空白页。

## 5. 后台状态与提醒

- 每个登录页面维护一条用户摘要流，与当前聊天流分开；切换项目或会话不关闭摘要流，退出登录必须关闭并清空，旧用户回调失效。
- 会话行区分运行中、待审批、待回答、恢复中、需核对、失败、空闲；项目入口汇总“需要用户处理”的数量，提供跨项目待处理列表。
- 展示优先级：删除中 > 未知操作待核对 > 待审批/待回答 > 恢复中 > 失败 > 运行中 > 空闲。只做展示归纳，不改变 SDK 执行状态。
- 审批与提问的待处理标记直到真实结算才消失；打开页面不能当作已处理。截止时间、倒计时和超时默认沿用原规则。
- 完成、最终失败、需要处理产生提醒；自动重试过程、普通 token、主动停止和空闲回收不产生“任务失败/完成”提醒。
- 完成/失败未读按用户同步；可见页面成功应用对应会话快照后，显式确认读到的 noticeVersion。只推进已读水位，不能吞掉期间新产生的提醒。
- 状态与计数常驻，toast 只辅助提醒；仅前台可见页面展示新增提醒，不移动焦点、不自动切会话，重连重放不重复弹。关闭全部页面后再次进入，摘要仍能重建待处理/未读。
- 用户摘要流先取快照再接增量，带 epoch + seq。会话流一并补齐 epoch 校验，进程重启即使 seq 恰好相同也必须对账。正文流与摘要流游标互不干扰。
- 分页目录版本与摘要事件游标不混用。摘要快照一次性返回本用户所有活跃/待处理会话与计数，另返回未读会话的轻量条目；历史目录分页只承担搜索/浏览。获取快照与捕获游标之间不插入未受保护的异步等待，后续增量从该游标接上；缓冲不足则重新取快照。
- 分页 cursor 绑定属主、workspace/q/archived 筛选、排序锚点及 listVersion。目录元信息增加每用户一行的 `user_catalog_state.listVersion`，与影响排序/筛选的修改同事务递增；纯运行指示和已读变化不递增。旧 cursor 版本不符返回 `CURSOR_EXPIRED`，前端清空分页结果重取第一页并按 sessionId 去重。用户摘要不丢弃；搜索列表收到管理/活动变更时重新按原筛选查询，不能把任意 upsert 直接塞回当前搜索结果。
- 只广播本用户的轻量摘要、通知身份和计数，不在全局摘要流复制正文、工具输出、密钥或文件内容。

## 6. 失败与恢复操作

界面就地展示“发生了什么／哪些结果已保留／下一步能做什么”，操作由服务端允许列表决定，前端不能按错误字符串猜测。

| 情况 | 展示与允许操作 | 执行语义 |
| --- | --- | --- |
| SSE 断开 | 正在重新连接／重试连接 | 只恢复页面连接，不重新发模型请求 |
| 模型请求最终失败 | 继续生成／调整当前配置后继续／放弃本轮 | 从持久化上下文发起下一请求，不重新提交原用户消息、不重跑已完成工具 |
| 单个工具失败或权限被拒绝 | 保留工具错误及原因 | 正常优先交 SDK 继续分析，不把每次工具报错都升级为整轮失败；新工具调用仍走审批 |
| 正常恢复执行失败 | 重试恢复／放弃本轮 | 重用检查点，保留队列、图片和原审批结算，不新增一套恢复引擎 |
| 工具效果未知 | 检查实际状态后继续／保持暂停／放弃本轮 | 不提供“无条件重做工具”；继续后要求先核对实际状态 |
| 凭据/模型配置错误 | 说明原因，提供现有设置页入口 | 不无限自动重试，不在本轮新增配置表单 |
| 检查点损坏、身份/工作区不符 | 明确阻止执行，提供可复制的脱敏诊断 | 不提供绕过校验的“强制恢复” |

- 新增共享 `RunIssue`：issueId、attemptId、kind、message、发生时间、revision、allowedActions。issue 只记录宿主诊断和操作条件，不能取代 SDK 的消息/工具结果；解决后清除。
- 失败说明和操作条件保存到现有运行检查点；扩展其清理规则，未处理 issue 不能随 agent_settled 被删除。刷新、换页及重启都能看到仍有效的失败状态。
- 恢复操作携带 actionId、issueId、expectedRevision，通过现有会话变更锁重查状态。数据库事务一起落“幂等收据 + 已接受运行意图”，再调用 SDK，覆盖“服务端已接受但 HTTP 回包丢失”的窗口。
- 接受意图存入现有运行检查点，包含 actionId、attemptId 和源 issue 版本；在 SDK 请求前使用公开 `SessionManager.appendCustomEntry` 写同 attemptId 的宿主开始标记，结束时写宿主完成/失败标记，再消费意图。标记不是伪造的助手消息，不参与模型正文。SQLite 与 JSONL 不能假装同一事务，重启必须对账：无开始标记则恢复已接受意图；有开始无结束则结合其后消息、工具结果和原输入检查点判断；已有结束标记则不再启动。最终响应已经落盘、但结束标记未写时，若正常终态及后续未完成工作能确定则直接补记结束，否则暂停核对，不能仅凭缺少结束标记再发一轮。已开始但结果未知的工具始终优先走原未知副作用规则；尚未消费的后续队列作为后续输入恢复，不能据此重做前一轮。
- 两页同时点击只接受一次；同 actionId 重试返回原接受结果，新 actionId 但版本过期返回冲突。任务已经完成、已经恢复、正在删除时不能再次续跑。
- 只使用公开 SDK 入口和 `runToolCall`，不调用私有 `_startRun`、不替换 streamFn，不将客户端工具参数直接交给工具执行。
- 保留现有 steer/followUp 两轨和各自图片。失败暂停期间明确保留队列；用户继续后按原轨道执行，放弃本轮时确认清空范围，历史保留。
- 用户主动停止不自动恢复；重试自动使用后续请求时的实际模型/思考设置，仍遵守当前运行模式。失败状态、审批结果、队列和目录摘要必须同步更新所有页面。
- 普通失败后用户主动发送新需求可开始新轮，并使旧 issue 操作失效；旧错误仍留在历史。未知副作用尚未核对时，新消息只进入可见队列，不能用“再发一句话”绕过恢复确认。仅有未处理 issue 的检查点在重启后展示暂停状态，不因启动扫描自行重试。

## 7. 扩展基础 Web 展示

| SDK UI 能力 | Web 落点与生命周期 |
| --- | --- |
| `notify` | 类型化通知事件；当前可见页 toast，重要通知进入会话通知水位，快照重放不再弹 |
| `setStatus(key, text)` | 轻量状态区，按 key 替换/删除；文字可查看完整内容，不抢占输入区域 |
| `setWorkingMessage`、可映射的 working 展示选项 | 更新当前运行提示；只影响文案/显示，隐藏指示器不能改变真实运行状态 |
| `setWidget(key, string[], options)` | 输入区上/下方对应位置的可折叠文字块，保留换行；删除、同 key 更新及位置遵循 SDK 定义 |
| `editor(title, prefill)` | 独立长文本对话框，提交/取消沿用 ApprovalManager，一页提交全页关闭；不直接覆盖聊天草稿 |

新增会话 UI 快照以及按 key 的更新事件，当前页刷新/切回可恢复状态和 widget；离开会话不清服务器状态。服务重启清除上个实例的运行期展示，明确显示恢复中，再由重建实例发布，不能重放一个早已失效的“正在执行”。

文字按文本展示；不执行扩展 HTML，不将终端控制码当浏览器指令。common 集中定义初始限额：key 最多 64 字符，status 最多 32 项、每项 512 字符，widget 最多 16 项、单项 16 KiB、合计 64 KiB，notify 单条 4 KiB，editor 提交最多 128 KiB；字节限额使用 UTF-8 长度校验。超限明确拒绝并反馈，不能静默截断用户提交。status/widget 在 200ms 窗口按 key 合并并在结束前刷新最终状态，不能逐字刷全局目录和 SQLite；通知保留最新 128 个事件身份用于去重。

长文本对话框共享请求身份、初始内容和结算；用户未提交的编辑草稿各页面独立，一页先提交后其他页提示已处理。审批正文与聊天输入草稿保持不同职责。

对话框恢复必须关联来源操作与稳定请求身份，不能恢复后生成新 UUID 让原五分钟重新开始。可安全重建的宿主操作复用原请求；任意扩展函数的调用栈不可能复活，来源操作不明或已有未知副作用时进入恢复核对，禁止显示能提交却无人接收的假卡片。

本轮不把 `getEditorText` 当成全局同步读取，也不广播 `setEditorText/pasteToEditor` 覆盖多页面草稿；这些方法后续需要发起页面与草稿版本协议。终端 factory/custom、主题和输入钩子继续明确不支持；不因补齐 UI 而开放磁盘扩展执行。

## 8. 模块、接口与依赖方向

| 位置 | 变更职责 |
| --- | --- |
| `backend/src/db/schema.ts`、`backend/drizzle/*` | 目录、每用户目录版本和恢复动作收据表，Drizzle Kit 生成迁移，保留旧数据 |
| `backend/src/modules/agent/session-catalog.ts`（新增） | 目录持久化、JSONL 回填/对账、分页搜索、管理元数据和未读水位 |
| `backend/src/modules/agent/user-events.ts`（新增） | 按属主广播摘要，epoch/seq、有限重放与断档对账；不执行会话业务 |
| `backend/src/modules/agent/agent.service.ts` | 编排重命名、归档、删除和恢复操作，校验身份及会话版本 |
| `backend/src/modules/agent/session-registry.ts` | 实例创建/释放，挂接摘要投影与删除保护；不继续堆叠目录 CRUD |
| `backend/src/modules/agent/runtime-store.ts`、`session-recovery.ts` | 扩展 issue/恢复动作事务与继续能力，仍负责检查点和 SDK 恢复 |
| `backend/src/modules/agent/session-ui.ts`（新增）、`ui-context.ts` | 前者拥有声明式 UI 状态与快照，后者桥接 SDK API；审批计时仍只有 ApprovalManager 一份 |
| `backend/src/routes/agent.route.ts`、`sse.route.ts` | 参数校验、鉴权、HTTP/SSE 接入，不放目录扫描或恢复逻辑 |
| `common/src/session-catalog.ts`、`extension-ui.ts`（新增）及现有 dto/messages/sse | 目录、RunIssue、UI 协议、Zod 请求校验、枚举与限额，不导入数据库或 SDK 实例 |
| `frontend/src/stores/sessions.ts`（新增） | 用户目录、全局摘要连接与未读；独立于切页会 reset 的 chat store |
| 现有 SidebarPanel/ProjectRail/ChatPage、api、连接与 chat store | 接入管理、状态、跨项目定位、issue 和 UI 快照 |
| 新增 `RecoveryNotice.tsx`、`ExtensionPanel.tsx` | 前者渲染允许恢复操作，后者渲染声明式状态/widget；菜单和编辑对话框复用现有组件 |

不新增 service/repository/interface 三层转发，也不把每个通知、状态 key 或按钮拆成独立文件。现有 `modules/system` 继续提供路径能力，agent 模块组织自身历史清理；认证不承担会话业务。

建议外部接口：

- `GET /api/sessions?workspace=&q=&archived=&cursor=&limit=`：目录查询，响应含 items、nextCursor、目录快照游标及跨项目待处理摘要；分页最大 100，默认 30。首次接入按同一发布同步更新旧调用方，不并行维护两份列表逻辑。
- `PATCH /api/sessions/:sessionId`：name 或 archived 与 expectedRevision；工作区仍使用既有编码约定，服务端以属主目录记录复核。
- `DELETE /api/sessions/:sessionId`：expectedRevision、stopIfRunning；停止删除来自明确确认，按会话生命周期幂等，不另设无实际用途的删除动作收据。
- `POST /api/sessions/:sessionId/read`：确认读到的 noticeVersion，不允许清除仍挂起审批。
- `POST /api/session/recovery`：既有会话 headers + actionId、issueId、expectedRevision、action（continue/retryRecovery/abandon）。具体动作由 allowedActions 校验。
- `GET /api/user/events`：本用户目录增量（upsert/remove），未读和摘要变化，带独立 epoch/seq；初次/断档读取目录摘要快照。分页 items 不能代替完整后台摘要，快照另含所有活跃/待处理会话的轻量信息。
- 现有会话 history/info 加 `issue`、`ui`、epoch；会话 SSE 增加对应变更事件，继续复用原审批结算接口。

## 9. 分阶段实施与验证

### 阶段一：目录和会话管理（非常重要）

接口：在 session-catalog 中提供 list、reconcile、updateMetadata、markRead；agent.service 编排 rename/archive/delete。此阶段同时交付 UserEventHub 的目录 upsert/remove、快照和 epoch/seq 连接基础，以及 SessionsStore 的会话列表同步；后续阶段在同一通道补充提醒投影，不另建第二条目录连接。

- [ ] 在 `backend/test/session-catalog.test.ts`、`session-management.test.ts` 写失败回归：旧历史回填、空白会话、名称落盘、分页/搜索/归档、筛选变化使游标失效且无重复/漏项、属主隔离、过期版本、运行删除、删除中断重启、旧 URL 不复活；先确认 FAIL。
- [ ] 实现目录/迁移及管理接口、用户目录摘要流和 SessionsStore，接入现有创建、关闭和会话变更锁；索引与 SDK 名称崩溃对账。用户流/会话流的 epoch 校验在此阶段完成，相关连接测试同步更新。
- [ ] 修改 SidebarPanel/api/common；在 `frontend/test/session-management.test.ts` 固定归档、搜索和删除导航语义，增加移动端菜单验收。
- [ ] 运行 `bun --no-env-file test packages/backend/test/session-catalog.test.ts packages/backend/test/session-management.test.ts` 及前端对应测试，预期 PASS。检查旧会话、队列、审批测试没有被删除语义破坏。

### 阶段二：后台状态与提醒（高）

接口：消费阶段一的 UserEventHub 与 SessionsStore；目录摘要补充真实状态、待处理分项计数、noticeVersion/readVersion，快照覆盖后台会话，不依赖当前聊天坐标。

- [ ] 在 `backend/test/user-events.test.ts` 和 `frontend/test/background-sessions.test.ts` 写并确认失败：A 后台审批/B 前台收到提醒、跨项目定位、用户隔离、自动重试不误报、多页已读竞争、归档待处理、epoch 相同 seq 重启、重放不重复 toast。
- [ ] 在既有用户摘要通道接入运行/待处理/未读投影，复用阶段一的 epoch 对账机制；不额外订阅所有会话正文。
- [ ] 侧栏/项目入口/待处理列表使用同一 store；确认提醒不抢焦点、不自动切 URL，审批计数直到后端 settle 才清除。
- [ ] 运行对应 Bun 测试并通过；用三个真实浏览器页面验证会话和项目切换、删除/归档广播及原五分钟截止时间。

### 阶段三：可操作失败恢复（非常重要）

接口：共享 RunIssue 与 allowedActions，现有 SessionRecovery 增加受版本约束的继续/重试入口；动作收据和运行意图同事务落盘。

- [ ] 在 `backend/test/recovery-actions.test.ts` 写并确认失败：丢响应后同 actionId 重试、两页竞争、已完成工具不重复、未知效果不能直接重做、恢复错误跨重启、自动重试终态、删除与继续竞争、草稿/两轨同文异图保留。
- [ ] 实现 issue 持久化、状态投影、允许动作和恢复接口；把现有未知效果确认接入同一套规则，避免同时出现两套相互冲突的继续按钮。
- [ ] 新增 RecoveryNotice；在 `frontend/test/recovery-actions.test.ts` 区分连接重试和模型继续，测试旧 issue 回调不影响新一轮，操作失败保留现状和可见原因。
- [ ] 对应测试通过后扩展真实 kill/restart 集成，分别验证接受意图后未写开始标记、已写开始但 SDK 未请求、SDK 已启动、工具结果未知、正常最终响应已落盘但未写结束标记、结束标记已写但 SQLite 意图未消费等崩溃窗口，以及超时和审批旧结果。不能只验证 HTTP 200。

### 阶段四：扩展基础 Web 展示（高）

接口：SessionUI 管理按 key 的 status/widgets、working 文案和通知事件，ui-context 调用它；history/info 与 SSE 同源投影，editor 仍经 ApprovalManager。

- [ ] 在 `backend/test/extension-ui.test.ts`、`frontend/test/extension-ui.test.ts` 写并确认失败：key 更新/删除、位置、换行、容量限制、背景通知、切回快照、重放去重、多页 editor 提交竞争和取消。
- [ ] 实现白名单声明式桥接；给 editor 补共享类型、请求来源和可恢复身份，对无法安全恢复的调用明确中断。
- [ ] ExtensionPanel 使用现有视觉 token、可折叠文本和可访问状态区域；长文本编辑与聊天草稿相互独立，不静默执行终端 factory。
- [ ] 对应测试通过，并在编译版浏览器验证无悬空对话框、无双重计时、切页/刷新不丢有效 UI 状态、重启不伪造旧工作提示。

### 阶段五：整体闭环与独立评审

- [ ] 更新 `docs/architecture.md` 与 `docs/pi-tui-web-coverage.md`，区分本轮真正支持的扩展 API 和仍不支持的终端能力。
- [ ] 执行 `bun run typecheck`、`bun run lint`、`bun run --cwd packages/backend db:check`、`bun --no-env-file test packages/backend`、`bun run --cwd packages/frontend test`，预期全部通过。
- [ ] 执行前端构建、Windows 单文件编译（保留内嵌迁移）和扩展后的 `browser_acceptance.py`。测试使用 D 盘临时数据与本机 Provider，不使用开发凭据；本轮不擅自触发外部计费模型请求。
- [ ] 独立复审本次全部差异及受影响调用链，修复确认的问题后再声明完成；不把设计文档或单元测试等同于实际 UI 闭环。

## 10. 必查的五类边界

1. 同一操作在多个页面、旧快照或 HTTP 超时重试中重复提交：版本校验与幂等结果必须一致（阶段一、二、三）。
2. 进程在 SQLite 提交与 JSONL 写入/删除之间退出：对账、deleting 标记和恢复意图不能误启动或遗失操作（阶段一、三）。
3. 待处理请求恰好在标记已读、切项目、删除和超时时变化：未读与仍待处理分开处理，原请求只能结算一次（阶段二、三）。
4. 用户切换、注销或源会话删除后旧异步事件到达：不能污染其他用户/会话、修改 URL 或复活已删除历史（阶段一、二）。
5. 扩展 UI 的重复 key、超长文本、无前台页面、非声明式 factory 和无法续栈对话框：必须有限、明确反馈，不占用无限资源或假装成功（阶段四）。

四项功能已按本计划实施，以下任务清单是设计阶段的详细验收设想，实际覆盖及替代验证见执行记录。沿用现有依赖、公开 SDK API 和模块，没有引入权限平台、通知平台、通用工作流或新的 AgentLoop。
