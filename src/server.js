import http from "node:http";
import { getConfig } from "./env.js";
import { createSyncService } from "./service.js";
import { createWorklogSyncService } from "./worklog-service.js";
import { createSyncQueue, startAssignmentScheduler, startWorklogScheduler } from "./scheduler.js";
import { syncWriteBlockReason } from "./sync-guard.js";

const config = getConfig();
const service = createSyncService(config);
const worklogService = createWorklogSyncService(config);
const enqueueSync = createSyncQueue();
let stopScheduler;
let stopWorklogScheduler;

function send(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${config.host}:${config.port}`}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return send(response, 200, {
        ok: true,
        assignmentStrategy: config.assignmentStrategy,
        assignmentScheduleEnabled: config.assignmentScheduleEnabled && !syncWriteBlockReason(config),
        worklogScheduleEnabled: config.worklogScheduleEnabled && !syncWriteBlockReason(config),
        syncWriteEnabled: !syncWriteBlockReason(config),
        syncWriteBlockReason: syncWriteBlockReason(config),
        jiraConfigured: Boolean(config.jiraUsername && config.jiraPassword),
        feishuConfigured: Boolean(
          config.feishuAppId
          && config.feishuAppSecret
          && config.feishuTableId
          && config.feishuDailyTableId,
        ),
        dailyTableConfigured: Boolean(config.feishuDailyTableId),
        worklogTableConfigured: Boolean(config.feishuWorklogTableId),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/preview") {
      return send(response, 200, await service.preview(url.searchParams.get("date")));
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      const body = await readJson(request);
      return send(response, 200, await enqueueSync(() => service.sync(body.date)));
    }
    if (request.method === "POST" && url.pathname === "/api/initialize") {
      const body = await readJson(request);
      if (!service.initialize) throw new Error("当前策略不支持基线初始化");
      return send(response, 200, await enqueueSync(() => service.initialize(body.date, body.baselineHash)));
    }
    if (request.method === "GET" && url.pathname === "/api/worklogs/preview") {
      const from = url.searchParams.get("from") || url.searchParams.get("date");
      const to = url.searchParams.get("to") || from;
      return send(response, 200, await worklogService.preview(from, to));
    }
    if (request.method === "POST" && url.pathname === "/api/worklogs/sync") {
      const body = await readJson(request);
      const from = body.from || body.date;
      const to = body.to || from;
      return send(response, 200, await enqueueSync(() => worklogService.sync(from, to)));
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Jira → 飞书派工同步服务已启动：http://${config.host}:${config.port}`);
  const blocked = syncWriteBlockReason(config);
  if (blocked) console.log(`[同步写入保护] ${blocked}`);
  if (config.assignmentScheduleEnabled && !blocked) {
    stopScheduler = startAssignmentScheduler({
      sync: (date) => enqueueSync(() => service.sync(date)),
    });
  }
  if (config.worklogScheduleEnabled && !blocked) {
    stopWorklogScheduler = startWorklogScheduler({
      sync: (from, to) => enqueueSync(() => worklogService.sync(from, to)),
    });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopScheduler?.();
    stopWorklogScheduler?.();
    server.close();
  });
}
