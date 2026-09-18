import { getConfig } from "./env.js";
import { createWorklogSyncService } from "./worklog-service.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const command = process.argv[2] || "preview";
const date = argument("--date");
const from = argument("--from") || date || new Date().toISOString().slice(0, 10);
const to = argument("--to") || date || from;

try {
  const service = createWorklogSyncService(getConfig());
  const result = command === "sync"
    ? await service.sync(from, to)
    : await service.preview(from, to);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
