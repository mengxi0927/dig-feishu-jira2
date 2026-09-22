import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withSyncWriteGuard } from "../src/sync-guard.js";
import { createSyncService } from "../src/service.js";
import { createWorklogSyncService } from "../src/worklog-service.js";

test("both service write entry points reject local/default config before network access", async () => {
  const config = { jiraBaseUrl: "https://jira.invalid", jiraUsername: "test", jiraPassword: "test" };
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests += 1; throw new Error("unexpected network"); };
  try {
    await assert.rejects(createSyncService(config).sync("2026-09-20"), /同步写入已禁用/);
    await assert.rejects(createWorklogSyncService(config).sync("2026-09-20", "2026-09-20"), /同步写入已禁用/);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("requires the exact designated hostname even when writes are enabled", async () => {
  await assert.rejects(withSyncWriteGuard({ syncWriteEnabled: true }, () => {}), /未指定/);
  await assert.rejects(withSyncWriteGuard({
    syncWriteEnabled: true, syncAllowedHostname: `${os.hostname()}-another-host`,
  }, () => {}), /当前主机不是/);
});

test("independent guard calls exclude concurrent writers and release on failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sync-guard-"));
  const config = {
    syncWriteEnabled: true, syncAllowedHostname: os.hostname(),
    stateFile: path.join(directory, "sync-state.json"),
  };
  let started;
  let release;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const first = withSyncWriteGuard(config, async () => {
      started();
      await gate;
      throw new Error("simulated failure");
    });
    const failed = assert.rejects(first, /simulated failure/);
    await ready;
    await assert.rejects(withSyncWriteGuard(config, () => assert.fail("concurrent write")), /拒绝并发/);
    release();
    await failed;
    assert.equal(await withSyncWriteGuard(config, () => 42), 42);
    // An orphaned lock is not silently stolen after a restart.
    await fs.mkdir(`${config.stateFile}.lock`);
    await assert.rejects(withSyncWriteGuard(config, () => {}), /拒绝并发/);
  } finally {
    release?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
