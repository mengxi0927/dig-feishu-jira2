import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JiraClient } from "../src/jira.js";
import { createWorklogSyncService } from "../src/worklog-service.js";
import {
  transformWorklogs,
  WORKLOG_EXPECTED_FIELDS,
  worklogSourceKey,
} from "../src/worklog.js";

function sampleEntry(overrides = {}) {
  return {
    issue: {
      id: "40994",
      key: "DIG-1",
      fields: {
        summary: "测试事项",
        project: { key: "DIG", name: "DIG 项目" },
        issuetype: { name: "任务" },
        status: { name: "处理中" },
        parent: { key: "DIG-EPIC" },
        reporter: { name: "reporter1", displayName: "报告人" },
        components: [{ name: "开发" }, { name: "测试" }],
        fixVersions: [{ name: "v1.0" }],
        timetracking: { originalEstimate: "8h", remainingEstimate: "3h" },
        customfield_10202: "DIG-EPIC",
        customfield_10204: "Epic 名称",
      },
    },
    worklog: {
      id: "205123",
      issueId: "40994",
      author: {
        name: "worker1",
        key: "worker1",
        emailAddress: "worker@example.com",
        displayName: "执行人",
      },
      comment: "完成开发",
      started: "2026-09-16T13:55:00.000+0800",
      updated: "2026-09-18T12:25:46.969+0800",
      timeSpent: "4h 30m",
      timeSpentSeconds: 16200,
    },
    ...overrides,
  };
}

test("maps Jira standard worklog and issue fields to the Chinese Feishu template", () => {
  const transformed = transformWorklogs([sampleEntry()], {
    epicLinkField: "customfield_10202",
    epicNameField: "customfield_10204",
    syncTimestamp: 123456789,
  });

  assert.equal(transformed.errors.length, 0);
  assert.equal(transformed.rows.length, 1);
  assert.equal(transformed.rows[0].sourceKey, worklogSourceKey("205123"));
  assert.equal(transformed.rows[0].sourceDay, "2026-09-16");
  assert.deepEqual(
    {
      issue: transformed.rows[0].fields["问题关键字"],
      hours: transformed.rows[0].fields["工时"],
      date: transformed.rows[0].fields["工作日期"],
      username: transformed.rows[0].fields["用户名"],
      fullName: transformed.rows[0].fields["全名"],
      activity: transformed.rows[0].fields["活动名称"],
      component: transformed.rows[0].fields["组件"],
      allComponents: transformed.rows[0].fields["全部组件"],
      project: transformed.rows[0].fields["项目关键字"],
      epic: transformed.rows[0].fields.Epic,
      epicLink: transformed.rows[0].fields["Epic Link"],
      billableFallback: transformed.rows[0].fields["有效工时数"],
      worklogId: transformed.rows[0].fields["Jira Worklog ID"],
      issueId: transformed.rows[0].fields["Jira Issue ID"],
      syncTime: transformed.rows[0].fields["同步时间"],
    },
    {
      issue: "DIG-1",
      hours: 4.5,
      date: "2026-09-16",
      username: "worker@example.com",
      fullName: "执行人",
      activity: "DIG 项目",
      component: "开发",
      allComponents: "开发, 测试",
      project: "DIG",
      epic: "Epic 名称",
      epicLink: "DIG-EPIC",
      billableFallback: 4.5,
      worklogId: "205123",
      issueId: "40994",
      syncTime: 123456789,
    },
  );
  assert.equal(transformed.summary.outputHours, 4.5);
});

test("deduplicates stable worklog IDs and reports invalid worklogs", () => {
  const duplicate = sampleEntry();
  const invalid = sampleEntry({
    worklog: { id: "", started: "bad", timeSpentSeconds: 0, author: {} },
  });
  const transformed = transformWorklogs([duplicate, duplicate, invalid]);

  assert.equal(transformed.rows.length, 1);
  assert.equal(transformed.summary.duplicateWorklogs, 1);
  assert.equal(transformed.errors.length, 1);
  assert.deepEqual(transformed.errors[0].codes, [
    "MISSING_WORKLOG_ID",
    "INVALID_WORK_DATE",
    "MISSING_AUTHOR",
    "INVALID_TIME_SPENT_SECONDS",
  ]);
});

test("keeps missing issue estimates blank instead of converting null to zero hours", () => {
  const entry = sampleEntry();
  entry.issue.fields.timetracking = {};
  entry.issue.fields.timeoriginalestimate = null;
  entry.issue.fields.timeestimate = null;

  const transformed = transformWorklogs([entry]);

  assert.equal(transformed.rows[0].fields["问题原估算时间"], "");
  assert.equal(transformed.rows[0].fields["问题剩余预估时间"], "");
});

test("fetches Jira worklogs through standard APIs and filters by work date", async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    const address = String(url);
    requested.push(address);
    let payload;
    if (address.endsWith("/rest/api/2/field")) {
      payload = [
        { id: "customfield_10202", name: "Epic Link" },
        { id: "customfield_10204", name: "Epic Name" },
      ];
    } else if (address.includes("/rest/api/2/search?")) {
      payload = {
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [{
          id: "40994",
          key: "DIG-1",
          fields: {
            worklog: {
              total: 2,
              worklogs: [{ id: "1", started: "2026-09-10T09:00:00.000+0800" }],
            },
          },
        }],
      };
    } else if (address.includes("/rest/api/2/issue/DIG-1/worklog?")) {
      payload = {
        startAt: 0,
        maxResults: 2,
        total: 2,
        worklogs: [
          { id: "1", started: "2026-09-10T09:00:00.000+0800" },
          { id: "2", started: "2026-08-31T09:00:00.000+0800" },
        ],
      };
    } else {
      throw new Error(`unexpected URL: ${address}`);
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
    const jira = new JiraClient({ baseUrl: "https://jira.example", username: "u", password: "p" });
    const result = await jira.fetchWorklogsRange("2026-09-01", "2026-09-18");
    assert.equal(result.issues.length, 1);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].worklog.id, "1");
    assert.equal(result.epicLinkField, "customfield_10202");
    assert.equal(result.epicNameField, "customfield_10204");
    assert.equal(requested.some((url) => url.includes("/issue/DIG-1/worklog?")), true);
  } finally {
    global.fetch = originalFetch;
  }
});

for (const scenario of ["legacy", "hours-alias", "duplicate-target", "wrong-type", "moved-date"]) {
test(`worklog sync handles ${scenario}`, async () => {
  const hoursField = scenario === "legacy" ? "工时" : "工时（小时）";
  const originalFetch = global.fetch;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jira-worklog-sync-"));
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
    if (address.endsWith("/rest/api/2/field")) {
      return response([
        { id: "customfield_10202", name: "Epic Link" },
        { id: "customfield_10204", name: "Epic Name" },
      ]);
    }
    if (address.includes("/rest/api/2/search?")) {
      const entry = sampleEntry();
      entry.issue.fields.worklog = { total: 1, worklogs: [entry.worklog] };
      return response({ total: 1, issues: [entry.issue] });
    }
    if (address.endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "tenant-token" });
    }
    if (address.includes("/tables/worklog-table/fields?")) {
      const numericFields = new Set([hoursField, "有效工时数"]);
      const dateFields = new Set(["工作日期", "Worklog 更新时间", "同步时间"]);
      return response({
        code: 0,
        data: {
          items: WORKLOG_EXPECTED_FIELDS.map((name) => name === "工时" ? hoursField : name).map((fieldName) => ({
            field_name: fieldName,
            type: scenario === "wrong-type" && fieldName === hoursField ? 1 : numericFields.has(fieldName) ? 2 : dateFields.has(fieldName) ? 5 : 1,
          })),
          has_more: false,
        },
      });
    }
    if (address.includes("/tables/worklog-table/records?") && options.method !== "POST") {
      return response({
        code: 0,
        data: {
          items: [{
            record_id: "existing-record",
            fields: {
              "Jira Worklog ID": "205123",
              "工作日期": Date.parse(`${scenario === "moved-date" ? "2026-09-15" : "2026-09-16"}T00:00:00+08:00`),
            },
          }, ...(scenario === "duplicate-target" ? [{ record_id: "duplicate-record", fields: { "Jira Worklog ID": "205123" } }] : [])],
          has_more: false,
        },
      });
    }
    if (address.includes("/records/batch_update")) {
      writes.push(JSON.parse(options.body));
      return response({ code: 0, data: {} });
    }
    throw new Error(`unexpected URL: ${address}`);
  };

  try {
    const stateFile = path.join(temporaryDirectory, "sync-state.json");
    const service = createWorklogSyncService({
      jiraBaseUrl: "https://jira.example",
      jiraUsername: "user",
      jiraPassword: "password",
      feishuAppId: "app-id",
      feishuAppSecret: "app-secret",
      feishuAppToken: "app-token",
      feishuWikiNodeToken: "",
      feishuWorklogTableId: "worklog-table",
      feishuWorklogHoursField: hoursField,
      timezoneOffset: "+08:00",
      stateFile,
      syncWriteEnabled: true,
      syncAllowedHostname: os.hostname(),
      strictFieldCheck: true,
      strictWorklogGovernance: true,
      worklogDeleteMissing: true,
      worklogJqlExtra: "",
      worklogConcurrency: 2,
      worklogPageSize: 100,
    });

    if (["duplicate-target", "wrong-type"].includes(scenario)) {
      await assert.rejects(service.sync("2026-09-16", "2026-09-16"), scenario === "duplicate-target" ? /重复 Jira Worklog ID/ : /必须存在且类型为数字/);
      assert.equal(writes.length, 0);
      await assert.rejects(fs.access(stateFile));
      return;
    }
    const result = await service.sync(scenario === "moved-date" ? "2026-09-15" : "2026-09-16", "2026-09-16");

    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.deleted, 0);
    assert.equal(result.bootstrappedRecords, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].records[0].record_id, "existing-record");
    assert.equal(writes[0].records[0].fields["Jira Worklog ID"], "205123");
    assert.equal(writes[0].records[0].fields[hoursField], 4.5);
    assert.equal(
      writes[0].records[0].fields["工作日期"],
      Date.parse("2026-09-16T00:00:00+08:00"),
    );

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.deepEqual(state.tables["app-token/worklog-table"].records["worklog:205123"], {
      recordId: "existing-record",
      day: "2026-09-16",
    });
  } finally {
    global.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
}

test("conflicting source worklog IDs are governance errors", () => {
  const first = sampleEntry();
  const second = sampleEntry();
  second.worklog.timeSpentSeconds = 3600;
  const result = transformWorklogs([first, second]);
  assert.equal(result.errors[0].codes[0], "CONFLICTING_WORKLOG_ID");
});

test("incomplete Jira pages fail instead of returning a partial snapshot", async () => {
  const jira = new JiraClient({ baseUrl: "https://jira.example", username: "u", password: "p" });
  for (const payload of [{}, { total: 2, issues: [], worklogs: [] }]) {
    jira.request = async () => payload;
    await assert.rejects(jira.searchIssues("", []), /停止同步/);
    await assert.rejects(jira.fetchIssueWorklogs("DIG-1"), /停止同步/);
  }
});
