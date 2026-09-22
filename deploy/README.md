# FDE-Prod-04 独立部署

2026-09-21 更新：已部署 `dig-feishu-jira2:20260921-worklog`，启用
`WORKLOG_SCHEDULE_ENABLED=true` 和 `FEISHU_WORKLOG_HOURS_FIELD=工时（小时）`。
派工、报工均在北京时间 06:00 调度，串行写入前一天的数据；首次报工定时运行
为 2026-09-22 06:00，同步 2026-09-21。本地及服务器镜像均通过 32 项测试。
Jira 同步账号时区已核实为 `Asia/Shanghai`，报工目标表 35 个字段名称和关键类型匹配。
已补同步 2026-09-20：新增 11 条、56 小时、更新 0 条、删除 0 条；
回读飞书确认 11 个唯一 Worklog ID，逐条核对工时、工作日期、Issue ID 及两个时间字段，均通过。
上线前配置与状态备份在 `backups/20260921-worklog/`；旧容器
`dig-feishu-jira2-sync-before-worklog-20260921` 已停止，仅用于回滚，不能与新容器同时启动。

以下为首次部署记录：

2026-09-20 已部署并启用：镜像 `dig-feishu-jira2:20260920-0600`，
容器 `dig-feishu-jira2-sync` 健康检查通过，自动重启策略为 `unless-stopped`。
Jira/飞书只读连接验证通过，目标工时字段配置为 `工时（小时）`。
已于 2026-09-20 将调度改为每天 06:00，下次运行北京时间 2026-09-21 06:00，同步 2026-09-20。
原首次计划运行北京时间 2026-09-20 12:00，同步 2026-09-19；
该日预览为 0 条。另用 2026-09-18 验证出 29 条明细、28 条汇总、227 小时，未写入该历史日期。
生产凭据仅保存在服务器 `shared/.env`，不包含在源码和镜像中。
本地 23 项测试通过；部署前原版本的 22 项测试也在服务器容器中通过。

目标主机：`10.126.50.207`，SSH 用户 `user`。
现有系统占用 8000/8001；本服务使用独立容器 `dig-feishu-jira2-sync`、
独立网络 `dig-feishu-jira2-net`，管理接口仅绑定 `127.0.0.1:18787`。
不修改现有站点和其 Docker 网络、数据库、网关或路由。

部署目录：`/opt/dig-feishu-jira2/`。

- `releases/<版本>/`：源码和 Dockerfile，不含生产密钥。
- `shared/.env`：生产配置，仅服务器持有，权限 600。
- `shared/data/sync-state.json`：持久化状态，迁移自原同步环境。
- `backups/`：上线前状态和容器清单备份。

容器以 UID 1000 运行。仅本服务数据目录允许该用户写入。
容器根文件系统只读，启用 `no-new-privileges`、移除 Linux capabilities，
独立网络，不挂载 Docker socket，不映射公网端口。
日志轮转最大 10 MB × 3，内存限额 256 MB，CPU 限额 0.5 核。

服务器配置包含原项目 `.env.example` 中的 Jira、飞书参数，并设置：

```text
HOST=0.0.0.0
PORT=8787
STATE_FILE=/app/data/sync-state.json
SYNC_ALLOWED_HOSTNAME=FDE-Prod-04
SYNC_WRITE_ENABLED=true
ASSIGNMENT_SCHEDULE_ENABLED=true
WORKLOG_SCHEDULE_ENABLED=true
FEISHU_WORKLOG_HOURS_FIELD=工时（小时）
```

Docker 必须使用 `--hostname FDE-Prod-04`，以匹配唯一同步服务器配置。
本地保持默认禁用写入和调度，不复制生产 `.env`，不在本地以生产主机名运行容器。
主机校验属于单服务器部署约束；目录锁只覆盖共享同一状态目录的进程，不是分布式锁。
每天北京时间 06:00 同步前一天派工及 Worklog 报工。

生产运行命令（完成配置、迁移状态和预览验证后执行；不能与旧同步进程并存）：

```bash
sudo docker run -d --name dig-feishu-jira2-sync \
  --label app=dig-feishu-jira2 \
  --hostname FDE-Prod-04 --network dig-feishu-jira2-net \
  --restart unless-stopped --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --cpus 0.5 --pids-limit 64 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file /opt/dig-feishu-jira2/shared/.env \
  --mount type=bind,src=/opt/dig-feishu-jira2/shared/data,dst=/app/data \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:18787:8787 \
  dig-feishu-jira2:<版本>
```

检查：`curl http://127.0.0.1:18787/health`。
查看日志：`sudo docker logs --tail 100 dig-feishu-jira2-sync`。
暂停全部同步：`sudo docker stop dig-feishu-jira2-sync`。
配置修改后需要重建此容器，`docker restart` 不会重新读取 env-file。
更新/回滚只停止并替换本项目容器，保留 `shared/data`，不执行全局清理命令。

如果进程被强制终止，先检查 `.lock/owner.json` 并确认旧同步已结束，
才可清理残留锁。部署后先做只读预览，确认配置和目标表，再开启写入和定时调度。
