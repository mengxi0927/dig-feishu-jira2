import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSyncService, syncTableRows } from "../src/service.js";
import { DAILY_EXPECTED_FIELDS, EXPECTED_FIELDS } from "../src/transform.js";

function fakeFeishu(existingFields) {
  return {
    tableId: "daily-table",
    updated: [],
    created: [],
    deleted: [],
    async listFields() {
      this.fieldMap = new Map(existingFields.map((field) => [field, { field_name: field }]));
      return this.fieldMap;
    },
    async resolveAppToken() {
      return "app-token";
    },
    serializeFields(fields) {
      return fields;
    },
    async batchUpdate(rows) {
      this.updated.push(...rows);
    },
    async batchCreate(rows) {
      this.created.push(...rows);
      return rows.map((_, index) => ({ record_id: `created-${index + 1}` }));
    },
    async batchDelete(recordIds) {
      this.deleted.push(...recordIds);
    },
  };
}

test("upserts daily rows and removes only stale rows for the requested date", async () => {
  const tableState = {
    records: {
      current: { recordId: "record-current", day: "2026-09-17" },
      stale: { recordId: "record-stale", day: "2026-09-17" },
      otherDay: { recordId: "record-other", day: "2026-09-16" },
    },
  };
  const state = { table: () => tableState };
  const feishu = fakeFeishu(["日期", "姓名", "项目号", "工时"]);

  const result = await syncTableRows({
    feishu,
    rows: [
      {
        sourceKey: "current",
        sourceDay: "2026-09-17",
        fields: { "日期": "2026-09-17", "姓名": "张三", "项目号": "DIG", "工时": 2 },
      },
      {
        sourceKey: "new",
        sourceDay: "2026-09-17",
        fields: { "日期": "2026-09-17", "姓名": "李四", "项目号": "DIG", "工时": 4 },
      },
    ],
    expectedFields: ["日期", "姓名", "项目号", "工时"],
    state,
    date: "2026-09-17",
    deleteMissing: true,
    strictFieldCheck: true,
    tableLabel: "日粒度表",
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(feishu.deleted, ["record-stale"]);
  assert.equal(tableState.records.new.recordId, "created-1");
  assert.equal("stale" in tableState.records, false);
  assert.equal(tableState.records.otherDay.recordId, "record-other");
});

test("stops before writing when a required target field is missing", async () => {
  const feishu = fakeFeishu(["日期", "姓名", "项目号"]);
  await assert.rejects(
    syncTableRows({
      feishu,
      rows: [],
      expectedFields: ["日期", "姓名", "项目号", "工时"],
      state: { table: () => ({ records: {} }) },
      date: "2026-09-17",
      deleteMissing: true,
      strictFieldCheck: true,
      tableLabel: "日粒度表",
    }),
    /缺少字段：工时/,
  );
  assert.equal(feishu.created.length, 0);
  assert.equal(feishu.updated.length, 0);
  assert.equal(feishu.deleted.length, 0);
});

test("preview returns both the raw rows and governed daily rows", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    let payload;
    if (String(url).endsWith("/rest/tempo-planning/1/plan/search")) {
      payload = [
        {
          allocationId: 300,
          assignee: "assignee1",
          day: "2026-09-17",
          planStart: "2026-09-17",
          planEnd: "2026-09-17",
          secondsPerDay: 3600,
          timePlannedSeconds: 3600,
          planItemInfo: { projectKey: "DIG", key: "DIG-1", summary: "事项" },
        },
      ];
    } else if (String(url).endsWith("/rest/api/2/project")) {
      payload = [{ key: "DIG", name: "DIG 项目" }];
    } else if (String(url).includes("/rest/api/2/user?")) {
      payload = { displayName: "执行人" };
    } else {
      throw new Error(`unexpected URL: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };

  try {
    const service = createSyncService({
      jiraBaseUrl: "https://jira.example",
      jiraUsername: "user",
      jiraPassword: "password",
    });
    const result = await service.preview("2026-09-17");
    assert.equal(result.rows, 1);
    assert.equal(result.daily.outputRows, 1);
    assert.equal(result.daily.data[0].fields["日期"], "2026-09-17");
    assert.equal(result.daily.data[0].fields["姓名"], "执行人");
    assert.equal(result.daily.data[0].fields["项目号"], "DIG");
    assert.equal(result.daily.data[0].fields["工时"], 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sync writes the raw and governed rows to separate Feishu tables", async () => {
  const originalFetch = global.fetch;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jira-feishu-sync-"));
  const writes = [];

  function response(payload) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  }

  global.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.endsWith("/rest/tempo-planning/1/plan/search")) {
      return response([
        {
          allocationId: 300,
          assignee: "assignee1",
          day: "2026-09-17",
          planStart: "2026-09-17",
          planEnd: "2026-09-17",
          secondsPerDay: 3600,
          timePlannedSeconds: 3600,
          planItemInfo: { projectKey: "DIG", key: "DIG-1", summary: "事项" },
        },
      ]);
    }
    if (address.endsWith("/rest/api/2/project")) {
      return response([{ key: "DIG", name: "DIG 项目" }]);
    }
    if (address.includes("/rest/api/2/user?")) {
      return response({ displayName: "执行人" });
    }
    if (address.endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "tenant-token" });
    }
    if (address.includes("/tables/raw-table/fields?")) {
      const numberFields = new Set([
        "Planned hours per day",
        "Number of planned days",
        "Planned hours total",
      ]);
      const dateFields = new Set([
        "From date",
        "To date",
        "Start time",
        "Approval status date",
        "Approval date and time",
      ]);
      return response({
        code: 0,
        data: {
          items: EXPECTED_FIELDS.map((fieldName) => ({
            field_name: fieldName,
            type: numberFields.has(fieldName) ? 2 : dateFields.has(fieldName) ? 5 : 1,
          })),
          has_more: false,
        },
      });
    }
    if (address.includes("/tables/daily-table/fields?")) {
      return response({
        code: 0,
        data: {
          items: DAILY_EXPECTED_FIELDS.map((fieldName) => ({
            field_name: fieldName,
            type: fieldName === "日期" ? 5 : fieldName === "工时" ? 2 : 1,
          })),
          has_more: false,
        },
      });
    }
    if (address.includes("/records/batch_create")) {
      const body = JSON.parse(options.body);
      const tableId = address.includes("/tables/raw-table/") ? "raw-table" : "daily-table";
      writes.push({ tableId, records: body.records });
      return response({
        code: 0,
        data: {
          records: body.records.map((_, index) => ({ record_id: `${tableId}-${index + 1}` })),
        },
      });
    }
    throw new Error(`unexpected URL: ${address}`);
  };

  try {
    const service = createSyncService({
      jiraBaseUrl: "https://jira.example",
      jiraUsername: "user",
      jiraPassword: "password",
      feishuAppId: "app-id",
      feishuAppSecret: "app-secret",
      feishuAppToken: "app-token",
      feishuWikiNodeToken: "",
      feishuTableId: "raw-table",
      feishuDailyTableId: "daily-table",
      timezoneOffset: "+08:00",
      stateFile: path.join(temporaryDirectory, "sync-state.json"),
      strictFieldCheck: true,
      strictDailyGovernance: true,
      deleteMissing: false,
      dailyDeleteMissing: true,
    });

    const result = await service.sync("2026-09-17");
    assert.equal(result.created, 1);
    assert.equal(result.daily.created, 1);
    assert.deepEqual(writes.map((write) => write.tableId), ["raw-table", "daily-table"]);
    assert.deepEqual(writes[1].records[0].fields, {
      "日期": Date.parse("2026-09-17T00:00:00+08:00"),
      "姓名": "执行人",
      "项目号": "DIG",
      "工时": 1,
    });

    const state = JSON.parse(await fs.readFile(path.join(temporaryDirectory, "sync-state.json"), "utf8"));
    assert.equal(Object.keys(state.tables["app-token/raw-table"].records).length, 1);
    assert.equal(Object.keys(state.tables["app-token/daily-table"].records).length, 1);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
