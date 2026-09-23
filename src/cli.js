import fs from "node:fs/promises";
import { getConfig } from "./env.js";
import { createSyncService } from "./service.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const command = process.argv[2] || "preview";
const date = argument("--date") || new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);

try {
  const service = createSyncService(getConfig());
  if (!["preview", "sync", "initialize", "adopt-classified"].includes(command)) throw new Error("命令必须为 preview、sync、initialize 或 adopt-classified");
  const result = command === "adopt-classified"
    ? await service.adoptClassifiedBaseline(JSON.parse(await fs.readFile(argument("--snapshot"), "utf8")).plans)
    : command === "initialize"
    ? await service.initialize(date, argument("--baseline-hash"))
    : command === "sync" ? await service.sync(date) : await service.preview(date);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
