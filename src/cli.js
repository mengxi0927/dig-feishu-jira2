import { getConfig } from "./env.js";
import { createSyncService } from "./service.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const command = process.argv[2] || "preview";
const date = argument("--date") || new Date().toISOString().slice(0, 10);

try {
  const service = createSyncService(getConfig());
  const result = command === "sync" ? await service.sync(date) : await service.preview(date);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
