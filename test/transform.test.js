import test from "node:test";
import assert from "node:assert/strict";
import { transformPlans } from "../src/transform.js";
import { validateDate } from "../src/service.js";

const fakeJira = {
  async getProjectNames() {
    return new Map([["DIG", "DIG 项目"]]);
  },
  async getUserDisplayName(accountId) {
    return { assignee1: "执行人", creator1: "派工人" }[accountId] || accountId;
  },
};

test("maps Tempo plan to the 23-column Feishu structure", async () => {
  const rows = await transformPlans([
    {
      allocationId: 100,
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
