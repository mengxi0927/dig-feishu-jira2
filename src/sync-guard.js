import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function syncWriteBlockReason(config) {
  if (!config.syncWriteEnabled) return "同步写入已禁用（SYNC_WRITE_ENABLED=false）";
  if (!config.syncAllowedHostname) return "未指定唯一同步主机 SYNC_ALLOWED_HOSTNAME";
  if (config.syncAllowedHostname !== os.hostname()) {
    return "当前主机不是 SYNC_ALLOWED_HOSTNAME 指定的同步服务器";
  }
  return "";
}

// 所有写入入口共用主机校验和状态目录锁。锁不自动过期，避免慢任务仍在写入时抢锁。
export async function withSyncWriteGuard(config, task) {
  const reason = syncWriteBlockReason(config);
  if (reason) throw new Error(reason);
  const lockPath = `${config.stateFile}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`已有同步任务或残留锁，拒绝并发写入：${lockPath}`);
    }
    throw error;
  }
  try {
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      hostname: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    return await task();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
