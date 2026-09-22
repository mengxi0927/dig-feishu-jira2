import test from "node:test";
import assert from "node:assert/strict";
import { FeishuClient } from "../src/feishu.js";

test("serializes the new metadata for text, single-select and hyperlink columns", () => {
  const client = new FeishuClient({});
  client.fieldMap = new Map([
    ["Sync status", { type: 3 }],
    ["Source", { type: 1 }],
    ["Jira Tempo PlanningIssue URL", { type: 15 }],
    ["Jira IssuePlan item type", { type: 1 }],
  ]);
  const fields = {
    "Sync status": "已同步",
    Source: "Jira Tempo Planning",
    "Jira Tempo PlanningIssue URL": "https://jira.example/browse/DIG-1",
    "Jira IssuePlan item type": "ISSUE",
  };
  assert.deepEqual(client.serializeFields(fields), {
    ...fields,
    "Jira Tempo PlanningIssue URL": { text: fields["Jira Tempo PlanningIssue URL"], link: fields["Jira Tempo PlanningIssue URL"] },
  });
  client.fieldMap.set("Jira Tempo PlanningIssue URL", { type: 1 });
  assert.deepEqual(client.serializeFields(fields), fields);
});

test("serializes date, time, number and text fields using Feishu field types", () => {
  const client = new FeishuClient({ timezoneOffset: "+08:00" });
  client.fieldMap = new Map([
    ["From date", { type: 5 }],
    ["Start time", { type: 5 }],
    ["Planned hours total", { type: 2 }],
    ["Issue key", { type: 1 }],
  ]);

  const result = client.serializeFields({
    "From date": "2026-09-17",
    "Start time": "09:30",
    "Planned hours total": 8,
    "Issue key": "DIG-1",
    "Not in table": "ignored",
  });

  assert.equal(result["From date"], Date.parse("2026-09-17T00:00:00+08:00"));
  assert.equal(result["Start time"], Date.parse("2026-09-17T09:30:00+08:00"));
  assert.equal(result["Planned hours total"], 8);
  assert.equal(result["Issue key"], "DIG-1");
  assert.equal("Not in table" in result, false);
});

test("serializes the governed daily table fields", () => {
  const client = new FeishuClient({ timezoneOffset: "+08:00" });
  client.fieldMap = new Map([
    ["日期", { type: 5 }],
    ["姓名", { type: 1 }],
    ["项目号", { type: 1 }],
    ["工时", { type: 2 }],
  ]);

  const result = client.serializeFields({
    "日期": "2026-09-17",
    "姓名": "执行人",
    "项目号": "DIG",
    "工时": 2.5,
  });

  assert.equal(result["日期"], Date.parse("2026-09-17T00:00:00+08:00"));
  assert.equal(result["姓名"], "执行人");
  assert.equal(result["项目号"], "DIG");
  assert.equal(result["工时"], 2.5);
});
