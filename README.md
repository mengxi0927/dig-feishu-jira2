# Jira 派工同步到飞书多维表格

本地 Node.js 服务。它按指定日期读取 Tempo Planning 派工数据，转换成 Excel 中定义的 23 个字段，然后批量新增或更新到飞书多维表格。

## 已采用的目标

- Jira：`POST /rest/tempo-planning/1/plan/search`
- 飞书多维表格 app token：`C8rxwJXuYimZsKkY0RKcjPxpnCf`
- 飞书数据表：`tblaButiER9WUiIJ`
- 唯一来源键：`allocationId + day`

服务不会在飞书表中增加额外字段。飞书 `record_id` 映射保存在本地 `data/sync-state.json`，所以重复同步同一天时会更新已有记录。

## 环境要求

- Node.js 18 或更高版本
- Jira/Tempo 只读账号
- 飞书自建应用，并允许访问目标 Wiki/多维表格
- 飞书应用具备读取多维表格字段、读取 Wiki 节点、批量新增记录、批量更新记录权限

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
```

不要把 `.env` 提交到代码仓库。

## 先预览 Jira 转换结果

预览不会写入飞书：

```bash
npm run preview -- --date 2026-09-17
```

## 执行一次同步

```bash
npm run sync -- --date 2026-09-17
```

第一次运行会新增记录；再次同步同一天时，会利用本地状态中的飞书 `record_id` 更新记录。

默认不会删除飞书记录。如果确认需要让飞书严格镜像 Jira，可在 `.env` 中设置：

```text
SYNC_DELETE_MISSING=true
```

开启后，服务仅删除“之前由本服务同步到该日期、现在 Jira 已不存在”的记录，不会扫描或删除其他手工记录。

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
- 写入前会读取飞书字段定义。默认要求 Excel 中的 23 个字段全部存在，否则停止写入。
- 飞书日期字段按照 `TIMEZONE_OFFSET=+08:00` 转成毫秒时间戳。
- 如果删除或迁移 `data/sync-state.json`，服务无法识别以前创建的飞书记录，再次同步可能产生重复数据。
