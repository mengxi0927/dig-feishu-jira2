import http from "node:http";
import { getConfig } from "./env.js";
import { createSyncService } from "./service.js";
import { createWorklogSyncService } from "./worklog-service.js";

const config = getConfig();
const service = createSyncService(config);
const worklogService = createWorklogSyncService(config);

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
      return send(response, 200, await service.sync(body.date));
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
      return send(response, 200, await worklogService.sync(from, to));
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Jira → 飞书派工同步服务已启动：http://${config.host}:${config.port}`);
});
