import test from "node:test";
import assert from "node:assert/strict";
import { dailySourceKey, transformDailyPlans, transformPlans } from "../src/transform.js";
import { validateDate } from "../src/service.js";

const fakeJira = {
  baseUrl: "https://jira.example",
  async getProjectNames() {
    return new Map([["DIG", "DIG 项目"]]);
  },
  async getUserDisplayName(accountId) {
    return { assignee1: "执行人", creator1: "派工人" }[accountId] || accountId;
  },
};

test("maps Tempo plan including the four additional Feishu fields", async () => {
  const rows = await transformPlans([
    {
      allocationId: 100,
      planItemType: "ISSUE",
      dateCreated: "2026-09-15",
      dateUpdated: "2026-09-16",
      assignee: "assignee1",
      day: "2026-09-17",
      planCreator: "creator1",
      planStart: "2026-09-17",
      planEnd: "2026-09-18",
      planStartTime: "09:30",
      secondsPerDay: 14400,
      timePlannedSeconds: 14400,
      _plannedDayCount: 2,
      _plannedSecondsTotal: 28800,
      planDescription: "测试派工",
      location: { name: "上海" },
      planItemInfo: { projectKey: "DIG", key: "DIG-1", summary: "测试事项" },
    },
  ], fakeJira);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceKey, "100|2026-09-17");
  assert.equal(rows[0].fields["Project name"], "DIG 项目");
  assert.equal(rows[0].fields["Planned hours per day"], 4);
  assert.equal(rows[0].fields["Number of planned days"], 2);
  assert.equal(rows[0].fields["Planned hours total"], 8);
  assert.equal(rows[0].fields["Assignee (Full name)"], "执行人");
  assert.equal(rows[0].fields["Location Name"], "上海");
  assert.equal(rows[0].fields["Sync status"], "已同步");
  assert.equal(rows[0].fields.Source, "Jira Tempo Planning");
  assert.equal(rows[0].fields["Jira Tempo PlanningIssue URL"], "https://jira.example/browse/DIG-1");
  assert.equal(rows[0].fields["Jira IssuePlan item type"], "ISSUE");
  assert.equal(rows[0].fields.allocationId, "100");
  assert.equal(rows[0].fields.dateCreated, "2026-09-15");
  assert.equal(rows[0].fields.dateUpdated, "2026-09-16");
});

test("does not invent item types or issue URLs for project plans", async () => {
  const rows = await transformPlans([
    { allocationId: 1, day: "2026-09-17", planItemType: "PROJECT", planItemInfo: { key: "DIG" } },
    { allocationId: 2, day: "2026-09-17", planItemInfo: {} },
  ], fakeJira);
  assert.equal(rows[0].fields["Jira IssuePlan item type"], "PROJECT");
  assert.equal(rows[0].fields["Jira Tempo PlanningIssue URL"], "");
  assert.equal(rows[1].fields["Jira IssuePlan item type"], "");
  assert.equal(rows[1].fields["Jira Tempo PlanningIssue URL"], "");
});

test("deduplicates by allocationId plus day", async () => {
  const plan = {
    allocationId: 100,
    day: "2026-09-17",
    secondsPerDay: 3600,
    timePlannedSeconds: 3600,
    planItemInfo: {},
  };
  const rows = await transformPlans([plan, plan], fakeJira);
  assert.equal(rows.length, 1);
});

test("validates calendar dates", () => {
  assert.equal(validateDate("2026-09-17"), "2026-09-17");
  assert.throws(() => validateDate("2026-02-30"), /有效日期/);
  assert.throws(() => validateDate("17-09-2026"), /YYYY-MM-DD/);
});

test("aggregates daily plans by date, project key and assignee name", async () => {
  const daily = await transformDailyPlans([
    {
      allocationId: 100,
      assignee: "assignee1",
      day: "2026-09-17",
      timePlannedSeconds: 3600,
      secondsPerDay: 28800,
      planItemInfo: { projectKey: "DIG", key: "DIG-1" },
    },
    {
      allocationId: 101,
      assignee: "assignee1",
      day: "2026-09-17",
      timePlannedSeconds: 5400,
      planItemInfo: { projectKey: "DIG", key: "DIG-2" },
    },
    {
      allocationId: 100,
      assignee: "assignee1",
      day: "2026-09-17",
      timePlannedSeconds: 3600,
      planItemInfo: { projectKey: "DIG", key: "DIG-1" },
    },
    {
      allocationId: 102,
      assignee: "creator1",
      day: "2026-09-17",
      secondsPerDay: 7200,
      planItemInfo: { key: "DIG-3" },
    },
  ], fakeJira);

  assert.equal(daily.errors.length, 0);
  assert.equal(daily.rows.length, 2);
  assert.deepEqual(
    daily.rows.find((row) => row.fields["姓名"] === "执行人"),
    {
      sourceKey: dailySourceKey("2026-09-17", "DIG", "执行人"),
      sourceDay: "2026-09-17",
      fields: {
        "日期": "2026-09-17",
        "姓名": "执行人",
        "项目号": "DIG",
        "工时": 2.5,
      },
    },
  );
  assert.equal(daily.rows.find((row) => row.fields["姓名"] === "派工人").fields["工时"], 2);
  assert.deepEqual(daily.summary, {
    inputPlans: 4,
    acceptedPlans: 3,
    duplicatePlans: 1,
    rejectedPlans: 0,
    outputRows: 2,
    inputHours: 4.5,
    outputHours: 4.5,
  });
});

test("reports invalid daily primary-key and hours data", async () => {
  const daily = await transformDailyPlans([
    {
      allocationId: 200,
      assignee: "assignee1",
      day: "2026-02-30",
      timePlannedSeconds: -1,
      planItemInfo: {},
    },
  ], fakeJira);

  assert.equal(daily.rows.length, 0);
  assert.deepEqual(daily.errors[0].codes, [
    "INVALID_DAY",
    "MISSING_PROJECT_KEY",
    "INVALID_PLANNED_SECONDS",
  ]);
  assert.equal(daily.summary.rejectedPlans, 1);
});
