# Jira 派工与报工同步到飞书多维表格

## 2026-09-21 派工策略更新

默认 `ASSIGNMENT_STRATEGY=monthly-delta`：每天06:00回溯30天，派工表追加变更日志；
未结算工时沿用原分组和计算方式并写入 allocationId，已结算变化每月22日按净差额写入
`工时信息-补录-x月` 的“补录工时（小时）”。月表自动创建、同月重跑复用。
Worklog 报工逻辑不变。下面原有按单日镜像派工的说明仅适用于 `legacy` 策略。

启用前必须预览并核对历史基线，再通过 `initialize --baseline-hash` 初始化；
未初始化时拒绝正式写入。月表字段引用复制、首次迁移、重试防重和已发现的26日/22日公式口径差异，
见 [工时补录分流设计](docs/工时补录分流设计.md)。本地完成开发不代表生产已经切换。

本地 Node.js 服务。它同步 Tempo Planning 派工和 Jira Worklog 报工数据：

1. 将每条 Tempo 派工日记录转换成 23 个业务字段和 4 个同步来源字段，写入派工基础表；
2. 对同一批数据按“日期 + 项目号 + 姓名”聚合，将某人某日在某项目上的派工工时写入日粒度治理表。
3. 使用 Jira 标准 REST API 拉取 Worklog 报工明细，转换成中文语义字段后写入报工表。

## 已采用的目标

- Jira：`POST /rest/tempo-planning/1/plan/search`
- 飞书多维表格 app token：`C8rxwJXuYimZsKkY0RKcjPxpnCf`
- 派工基础表：`tblaButiER9WUiIJ`
- 日粒度治理表：`tblwy3hWdQIv1JhL`
- 报工明细表：`tblZjQL48vL9oOAZ`
- 基础表唯一来源键：`allocationId + day`
- 日粒度表联合主键：`日期 + 项目号 + 姓名`
- 报工表唯一来源键：`Jira Worklog ID`

服务不会在飞书表中增加额外字段。各目标表的飞书 `record_id` 映射分别保存在本地 `data/sync-state.json`，所以重复同步同一日期范围时会更新已有记录。

## 环境要求

- Node.js 18 或更高版本
- Jira/Tempo 只读账号
- 飞书自建应用，并允许访问目标 Wiki/多维表格
- 飞书应用具备读取多维表格字段、批量新增记录、批量更新记录、批量删除记录权限；仅使用 Wiki 节点 token 时还需读取 Wiki 节点权限

当前配置已直接使用 `FEISHU_APP_TOKEN`，不需要 Wiki 读取权限。

## 配置

```bash
cp .env.example .env
```

编辑 `.env`，填写：

```text
JIRA_USERNAME=你的 Jira 用户名
JIRA_PASSWORD=你的 Jira 密码
FEISHU_APP_ID=飞书应用 App ID
FEISHU_APP_SECRET=飞书应用 App Secret
FEISHU_APP_TOKEN=C8rxwJXuYimZsKkY0RKcjPxpnCf
FEISHU_TABLE_ID=tblaButiER9WUiIJ
FEISHU_DAILY_TABLE_ID=tblwy3hWdQIv1JhL
FEISHU_WORKLOG_TABLE_ID=tblZjQL48vL9oOAZ
```

不要把 `.env` 提交到代码仓库。

## 先预览 Jira 转换结果

预览不会写入飞书：

```bash
npm run preview -- --date 2026-09-17
```

结果中的 `data` 是 23 字段基础数据；`daily.data` 是治理后的四字段数据。建议先确认：

```json
{
  "日期": "2026-09-17",
  "姓名": "张三",
  "项目号": "D5GP9FG164",
  "工时": 8
}
```

## 执行一次同步

写入仅允许在指定服务器上执行；本地默认只预览。先按下文“服务器独立部署”配置写入开关及主机名。

```bash
npm run sync -- --date 2026-09-17
```

一次同步会先写基础表，再写日粒度表。第一次运行会新增记录；再次同步同一天时，会利用本地状态中的飞书 `record_id` 更新记录。

默认不会删除飞书记录。如果确认需要让飞书严格镜像 Jira，可在 `.env` 中设置：

```text
SYNC_DELETE_MISSING=true
```

开启后，服务仅删除“之前由本服务同步到该日期、现在 Jira 已不存在”的记录，不会扫描或删除其他手工记录。

日粒度表默认设置 `SYNC_DAILY_DELETE_MISSING=true`。这是因为姓名、项目号或派工归属变化后，联合主键也会变化；服务会删除本地状态中同一天的旧联合主键记录。删除范围仍仅限本服务曾经创建的记录。如需只增不删，可改成：

```text
SYNC_DAILY_DELETE_MISSING=false
```

日粒度治理默认使用严格模式：只要源数据缺少日期、项目号、人员或有效工时，就在两张表写入前停止。可先通过 `preview` 查看 `daily.errors`。不建议关闭；确需跳过异常记录继续同步时，可配置：

```text
STRICT_DAILY_GOVERNANCE=false
```

## Jira Worklog 报工同步

报工链路只使用 Jira 标准接口：

- `GET /rest/api/2/field`：识别 Epic 字段；
- `GET /rest/api/2/search`：通过 `worklogDate` JQL 分页查找相关 Issue；
- `GET /rest/api/2/issue/{issueKey}/worklog`：当搜索结果中的 Worklog 未完整展开时分页补取。

先预览日期范围：

```bash
npm run worklog:preview -- --from 2026-09-01 --to 2026-09-18
```

确认后同步：

```bash
npm run worklog:sync -- --from 2026-09-01 --to 2026-09-18
```

也可以只处理一天：

```bash
npm run worklog:sync -- --date 2026-09-18
```

每条 Worklog 使用 `Jira Worklog ID` 作为稳定来源键。同步前会读取目标表，利用已有的 `Jira Worklog ID` 恢复本地映射，因此迁移运行环境后也能避免重复新增。默认情况下，指定日期范围会严格镜像 Jira：已由本服务识别、但已从 Jira 删除或移出日期范围的 Worklog 会从飞书删除。

标准接口可以直接提供问题、项目、用户、日期、工时、描述、组件、版本、父问题、报告人、估算和 Worklog ID。以下 Tempo 专属字段不在 Jira 标准 Worklog 响应中，保持空值：

- 周期；
- Account Key/Name/Lead/Category/Customer；
- Location Name；
- Account Approval Status；
- 外部工时数。

`活动名称` 使用 Jira 项目名称作为稳定替代；`有效工时数` 在标准接口没有 Tempo billable seconds 时等于实际报工工时。

可选配置：

```text
STRICT_WORKLOG_GOVERNANCE=true
WORKLOG_SYNC_DELETE_MISSING=true
WORKLOG_JQL_EXTRA=
WORKLOG_CONCURRENCY=6
WORKLOG_PAGE_SIZE=100
```

目标表的“工时（小时）”和“有效工时数”应配置为数字字段并保留需要的小数位；Jira Worklog 可能出现 `4.5` 小时等非整数工时。
`FEISHU_WORKLOG_HOURS_FIELD` 默认 `工时（小时）`，与 2026-09-21 提供的报工模板一致；旧表可设为 `工时`。预览继续使用逻辑字段“工时”。

### 报工导入校验

模板已有 35 列，不需要增加必填列。保留以下追溯字段：

| 字段 | 飞书类型 | 用途 |
|---|---|---|
| Jira Worklog ID | 文本 | 每条报工的唯一来源键；重跑更新，不重复新增 |
| Jira Issue ID | 文本 | 对应 Jira 问题的稳定标识 |
| Worklog 更新时间 | 日期时间 | 来源记录的最近修改时间 |
| 同步时间 | 日期时间 | 该行最近成功写入时携带的同步批次时间 |

写入前检查必填来源 ID、问题关键字、人员、有效工作日期、正数工时，并检查目标关键字段类型。
相同来源 ID 的完全重复数据只保留一次，内容冲突按异常处理；目标表出现重复 Worklog ID 时停止整批写入。
Jira 分页返回不完整时停止同步，避免把缺失页误当成删除记录。
严格模式下源数据异常停止整批写入；关闭严格模式后可跳过异常，但该批次禁止删除。
这些检查在接口中执行，无需人工填写“校验通过”等字段。

工作日期取 Jira `started` 的日期部分，请确保 Jira 同步账号与业务工作日期均使用北京时间。
每天仅同步前一天的工作日期，后续补录或修改更早日期的数据需按日期范围手动补同步。

## 启动 HTTP 服务

```bash
npm start
```

### 每天自动同步派工与报工

服务器启用 `ASSIGNMENT_SCHEDULE_ENABLED=true` 和写入权限后，
`npm start` 同时启动内置定时任务，每天北京时间（UTC+8）06:00
同步前一个日历日的派工基础表和日粒度治理表。
启用 `WORKLOG_SCHEDULE_ENABLED=true` 后，同一时间另行调度 Worklog 报工同步，
两个任务通过同一队列串行写入，派工失败也不阻止报工任务执行。
例如 9 月 21 日早上 6 点运行时同步 9 月 20 日。调度不依赖服务器的系统时区。

服务器部署时，填写 `.env` 中的 Jira 和飞书配置，并使用进程管理器保持
`npm start` 常驻运行。设置 `ASSIGNMENT_SCHEDULE_ENABLED=false` 可关闭调度。
运行开始、完成和失败信息写入标准输出/错误；失败后下一天继续调度，
不会自动重试。服务启动时只安排下一个早上 6 点，不补跑停机期间错过的任务；
需要补数据时使用 `npm run sync -- --date YYYY-MM-DD`。

定时任务与 HTTP 派工、报工同步在同一进程内串行执行，避免覆盖共享状态。
CLI 与服务进程共用状态文件目录锁，并发写入会被拒绝。
请只运行一个服务实例，各入口必须使用同一个绝对路径 `STATE_FILE`。
部署或迁移时保留 `data/sync-state.json`，以便更新已有飞书记录、避免重复新增。

### 服务器独立部署

本地 `.env` 保持 `SYNC_WRITE_ENABLED=false` 和
`ASSIGNMENT_SCHEDULE_ENABLED=false`、`WORKLOG_SCHEDULE_ENABLED=false`（也是代码默认值）。所有派工、报工的
HTTP、CLI、定时写入都会检查开关和运行主机名，预览不受影响。

部署前必须检查服务器现有目录、监听端口和进程管理方式。为本项目使用独立
目录、运行用户、服务名称和状态文件；HTTP 仅绑定 `127.0.0.1` 的空闲端口，
无需修改 `l2c-platform.scity.cn` 现有站点路由、Nginx 或现有项目服务。
Node.js 要求 18 或更高版本。

服务器 `.env` 设置以下值（主机名取服务器 `hostname` 的实际输出，不是域名）：

```text
SYNC_WRITE_ENABLED=true
SYNC_ALLOWED_HOSTNAME=<唯一同步服务器的实际主机名>
ASSIGNMENT_SCHEDULE_ENABLED=true
WORKLOG_SCHEDULE_ENABLED=true
FEISHU_WORKLOG_HOURS_FIELD=工时（小时）
HOST=127.0.0.1
PORT=<检查后确认空闲的独立端口>
STATE_FILE=<该项目持久化目录>/sync-state.json
```

仅服务器保存生产 Jira/飞书凭据。不要将服务器 `.env` 复制到本地或提交 Git。
即使复制配置到另一台不同主机名的机器，写入也会被拒绝。
这是“指定唯一写入主机”的部署约束，不是跨机器分布式锁：不能为两台主机分别授权，
也不能让多个独立容器冒用同一主机名、使用不同状态目录同时运行。

切换步骤：停止旧同步进程 → 确认本地禁用写入 → 备份并迁移最后一次成功的
`sync-state.json` → 设置服务器配置 → 用进程管理器启动单实例
`node src/server.js` → 检查 `/health` 中 `syncWriteEnabled` 和
`assignmentScheduleEnabled` 均为 `true` → 预览验证数据后执行同步。
缺少旧状态时不要直接同步已有派工表，以免重复新增。

锁位于 `STATE_FILE` 后加 `.lock` 的目录，包含运行主机、PID 和开始时间。
正常成功或失败均会释放；进程被强制终止时可能残留。
必须确认旧进程已经结束、没有同步写入，再人工清理该锁目录后重试。
锁不会自动过期，防止慢任务仍在运行时被其他进程抢占。

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

预览指定日期：

```bash
curl 'http://127.0.0.1:8787/api/preview?date=2026-09-17'
```

同步指定日期：

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-17"}' \
  http://127.0.0.1:8787/api/sync
```

Worklog 日期范围预览与同步：

```bash
curl 'http://127.0.0.1:8787/api/worklogs/preview?from=2026-09-01&to=2026-09-18'

curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-09-01","to":"2026-09-18"}' \
  http://127.0.0.1:8787/api/worklogs/sync
```

## 字段映射

### 日粒度治理表

代码预览中的逻辑字段为“工时”。当前目标“工时信息”表的实际字段名为
“工时（小时）”，需配置 `FEISHU_DAILY_HOURS_FIELD=工时（小时）`；
正式同步时映射到该字段，无需改动飞书表结构。未配置时兼容原字段“工时”。

请在 `tblwy3hWdQIv1JhL` 中准备以下字段，字段名称必须完全一致：

| 飞书字段 | 建议字段类型 | Jira/Tempo 来源 |
|---|---|---|
| 日期 | 日期 | `day` |
| 姓名 | 单行文本 | `assignee` 经 Jira 用户接口补全的显示名 |
| 项目号 | 单行文本 | `planItemInfo.projectKey`；缺失时从 Issue Key 提取 |
| 工时 | 数字 | 同一联合主键下 `timePlannedSeconds` 求和后除以 3600 |

Tempo 搜索接口已经按日期展开，因此日工时优先使用该日的 `timePlannedSeconds`；只有旧版响应没有该字段时才回退到 `secondsPerDay`。同一个 `allocationId + day` 若在接口中重复出现只计一次，不同 Issue/派工记录落在同一联合主键时会合并求和。

### 派工基础表

| 飞书字段 | Jira/Tempo 来源 |
|---|---|
| From date | `planStart` |
| To date | `planEnd` |
| Start time | `planStartTime` |
| Project key | `planItemInfo.projectKey` |
| Project name | Jira 项目列表中的项目名称 |
| Issue key | `planItemInfo.key` |
| Issue summary | `planItemInfo.summary` |
| Planned hours per day | `secondsPerDay / 3600` |
| Number of planned days | 对同一 `allocationId` 的实际计划日期计数 |
| Planned hours total | 对同一 `allocationId` 各计划日的 `timePlannedSeconds` 求和后除以 3600 |
| Description | `planDescription` |
| Assignee | `assignee`，并通过 Jira 用户接口补全姓名 |
| Planned by | `planCreator`，并通过 Jira 用户接口补全姓名 |
| Location Name | `location.name` |
| Sync status | `已同步`，与该行数据一起写入，表示派工基础表记录已同步，不代表日粒度表也成功 |
| Source | `Jira Tempo Planning` |
| Jira Tempo PlanningIssue URL | Jira 基础地址 + `/browse/` + 事项编号；非 ISSUE 计划或缺少事项编号时留空 |
| Jira IssuePlan item type | Tempo 的 `planItemType` 原值，缺失时留空 |

以上四个新增字段在新增及更新记录时都会写入。预览展示拟写入值，不表示已经完成同步。导出表中的 `Jira created at` 和 `Sync batch ID` 不在本次新增四字段范围内，暂不填充。

`planItemType` 的字段含义参考 [Tempo Data Center 官方 API 示例](https://help.tempo.io/kb/latest/import-plans-using-the-tempo-rest-api-on-data-cent)。

当前 Tempo 查询响应不包含 Reviewer 和 Approval 相关信息，因此对应字段保持空值。

Tempo 的搜索响应按日期展开。服务先查询目标日有哪些派工，再使用这些事项编号补查派工的完整起止区间，按 `allocationId` 汇总计划天数和总小时；不会把“当天小时”误当成“整段派工总小时”。

## 安全和运行说明

- 服务默认只监听 `127.0.0.1`，不会暴露到局域网。
- 密码和 App Secret 仅从 `.env` 读取，不会写入同步状态。
- 写入前会读取飞书字段定义。默认要求基础表的 27 个字段、日粒度表的 4 个字段和报工表的 35 个字段全部存在，否则停止对应链路的写入。
- 飞书日期字段按照 `TIMEZONE_OFFSET=+08:00` 转成毫秒时间戳。
- 派工链路依赖 `data/sync-state.json`，部署时应将 `data/` 作为持久化目录并定期备份。报工链路还能通过目标表中的 `Jira Worklog ID` 自动恢复映射。
