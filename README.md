# Jira 派工同步到飞书多维表格

本地 Node.js 服务。它按指定日期读取 Tempo Planning 派工数据，并同步两层数据：

1. 将每条 Tempo 派工日记录转换成 Excel 中定义的 23 个字段，写入派工基础表；
2. 对同一批数据按“日期 + 项目号 + 姓名”聚合，将某人某日在某项目上的派工工时写入日粒度治理表。

## 已采用的目标

- Jira：`POST /rest/tempo-planning/1/plan/search`
- 飞书多维表格 app token：`C8rxwJXuYimZsKkY0RKcjPxpnCf`
- 派工基础表：`tblaButiER9WUiIJ`
- 日粒度治理表：`tblwy3hWdQIv1JhL`
- 基础表唯一来源键：`allocationId + day`
- 日粒度表联合主键：`日期 + 项目号 + 姓名`

服务不会在飞书表中增加额外字段。两张表的飞书 `record_id` 映射分别保存在本地 `data/sync-state.json`，所以重复同步同一天时会更新已有记录。

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

## 启动 HTTP 服务

```bash
npm start
```

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

## 字段映射

### 日粒度治理表

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

当前 Tempo 查询响应不包含 Reviewer 和 Approval 相关信息，因此对应字段保持空值。

Tempo 的搜索响应按日期展开。服务先查询目标日有哪些派工，再使用这些事项编号补查派工的完整起止区间，按 `allocationId` 汇总计划天数和总小时；不会把“当天小时”误当成“整段派工总小时”。

## 安全和运行说明

- 服务默认只监听 `127.0.0.1`，不会暴露到局域网。
- 密码和 App Secret 仅从 `.env` 读取，不会写入同步状态。
- 写入前会读取飞书字段定义。默认要求基础表的 23 个字段和日粒度表的 4 个字段全部存在，否则停止写入。
- 飞书日期字段按照 `TIMEZONE_OFFSET=+08:00` 转成毫秒时间戳。
- 如果删除或迁移 `data/sync-state.json`，服务无法识别以前创建的飞书记录，再次同步可能产生重复数据。部署时应将 `data/` 作为持久化目录并定期备份。
