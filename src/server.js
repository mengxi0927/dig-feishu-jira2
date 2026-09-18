import http from "node:http";
import { getConfig } from "./env.js";
import { createSyncService } from "./service.js";

const config = getConfig();
const service = createSyncService(config);

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
        feishuConfigured: Boolean(config.feishuAppId && config.feishuAppSecret && config.feishuTableId),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/preview") {
      return send(response, 200, await service.preview(url.searchParams.get("date")));
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      const body = await readJson(request);
      return send(response, 200, await service.sync(body.date));
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Jira → 飞书派工同步服务已启动：http://${config.host}:${config.port}`);
});
