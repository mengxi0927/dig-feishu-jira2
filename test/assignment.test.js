import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssignmentService } from "../src/assignment-service.js";
import { adjustmentRows, changes, periodStart, scheduleRange, snapshotPlans } from "../src/assignment-model.js";
import { cloneDefinition } from "../src/assignment-tables.js";
import { transformDailyPlans } from "../src/transform.js";
import { JiraClient } from "../src/jira.js";

function plan(id, date, hours, project = "DIG", person = "person") {
  return { allocationId: id, day: date, assignee: person, planStart: date, planEnd: date,
    timePlannedSeconds: hours * 3600, secondsPerDay: hours * 3600,
    planItemInfo: { projectKey: project, key: `${project}-1` } };
}
const jiraBase = { getProjectNames: async () => new Map(), getUserDisplayName: async id => id };

test("source deltas handle increases, reductions, deletion and moves without changing totals", async () => {
  const snap = p => snapshotPlans(p, jiraBase);
  const before = await snap([plan(1, "2026-08-01", 5)]);
  for (const [hours, expected] of [[8, 3], [2, -3], [0, -5]]) {
    const after = await snap(hours ? [plan(1, "2026-08-01", hours)] : []);
    assert.equal(adjustmentRows(before, after, "2026-08-22", "2026-01-01", 1)[0].fields["补录工时（小时）"], expected);
    assert.equal(adjustmentRows(before, after, "2026-08-22", "2026-01-01", 1)[0].fields["派工识别id"], "120260801");
  }
  assert.equal(adjustmentRows({}, before, "2026-08-22", "2026-01-01", 1)[0].fields["补录工时（小时）"], 5);
  const moved = await snap([plan(1, "2026-08-02", 5, "OTHER")]);
  assert.deepEqual(adjustmentRows(before, moved, "2026-08-22", "2026-01-01", 1).map(r => r.fields["补录工时（小时）"]).sort((a,b)=>a-b), [-5, 5]);
  assert.equal(adjustmentRows(before, before, "2026-08-22", "2026-01-01", 1).length, 0);
});

test("allocation metadata does not change existing aggregation or rounded hours", async () => {
  const plans = [plan(11, "2026-09-01", 1.25), plan(12, "2026-09-01", 3.5), plan(11, "2026-09-01", 1.25)];
  const old = await transformDailyPlans(plans, jiraBase);
  const enriched = await transformDailyPlans(plans, jiraBase, { includeAllocationIds: true });
  assert.equal(enriched.rows[0].fields["派工识别id"], "1120260901,1220260901");
  delete enriched.rows[0].fields["派工识别id"];
  assert.deepEqual(enriched, old);
});

test("range querying preserves whole-plan totals while returning only requested daily rows", async () => {
  const jira = new JiraClient({ baseUrl: "https://example.invalid", username: "", password: "" });
  const one = { ...plan(1, "2026-09-20", 4), planStart: "2026-09-20", planEnd: "2026-09-22" };
  const calls = [];
  jira.fetchPlansRange = async (from, to) => {
    calls.push([from,to]);
    return to === "2026-09-20" ? [one] : [one, { ...one, day: "2026-09-21" }, { ...one, day: "2026-09-22" }];
  };
  const result = await jira.fetchPlanAllocationsRange("2026-08-22", "2026-09-20");
  assert.equal(result.length, 1);
  assert.equal(result[0]._plannedDayCount, 3);
  assert.equal(result[0]._plannedSecondsTotal, 12 * 3600);
  assert.deepEqual(calls[1], ["2026-09-20", "2026-09-22"]);
});

test("calendar includes all 31 days of closing period, catches missed 22nd and keeps rolling window", () => {
  assert.equal(periodStart("2026-01-10"), "2025-12-22");
  assert.equal(periodStart("2026-02-22"), "2026-02-22");
  const state = { initialized: true, closedThrough: "2026-08-21" };
  assert.equal(scheduleRange("2026-09-20", state).monthly, false);
  assert.equal(scheduleRange("2026-09-21", state).monthly, true);
  assert.equal(scheduleRange("2026-09-22", state).monthly, true);
  assert.equal(scheduleRange("2026-09-21", state).openFrom, "2026-08-22");
  assert.equal(scheduleRange("2026-09-22", { ...state, closedThrough: "2026-09-21" }).from, "2026-08-24");
});

test("snapshot rejects conflicting or missing allocation IDs; recurring identical change has new event ID", async () => {
  const p = plan(1, "2026-09-01", 1);
  await assert.rejects(snapshotPlans([p, { ...p, timePlannedSeconds: 7200 }], jiraBase), /不同内容/);
  await assert.rejects(snapshotPlans([{ ...p, allocationId: undefined }], jiraBase), /allocationId/);
  const a = await snapshotPlans([p], jiraBase);
  const b = await snapshotPlans([{ ...p, timePlannedSeconds: 7200 }], jiraBase);
  assert.notEqual(changes(a,b,1)[0].id, changes(a,b,3)[0].id);
});

test("schema copying replaces local field/table references and preserves external references", () => {
  const result = cloneDefinition({ field_name: "WBS", type: 20, property: {
    formula_expression: "bitable::$table[tblOld].$field[fldOld]+bitable::$table[tblExternal].$field[fldExternal]",
    type: { data_type: 1 },
  } }, new Map([["tblOld", "tblNew"], ["fldOld", "fldNew"]]));
  assert.equal(result.property.formula_expression, "bitable::$table[tblNew].$field[fldNew]+bitable::$table[tblExternal].$field[fldExternal]");
  assert.equal(result.property.type, undefined);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-delta-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = new Date("2026-09-20T00:00:00Z");
  let plans = [plan(1, "2026-08-10", 5), plan(2, "2026-09-18", 2)];
  let n = 0;
  const tables = new Map();
  const fields = ["项目号", "姓名", "allocationId", "派工识别id"].map(field_name => ({ field_name, type: 1 }));
  fields.push({ field_name: "日期", type: 5 }, { field_name: "工时（小时）", type: 2 }, { field_name: "补录工时（小时）", type: 2 });
  for (const [id, name] of [["raw", "派工日志"], ["normal", "工时信息"], ["template", "工时信息-补录-9月"]]) tables.set(id, {
    name, fields: new Map(fields.map(f => [f.field_name, { ...f, field_id: `fld${++n}` }])), records: [],
  });
  const initial = await transformDailyPlans(plans, jiraBase);
  tables.get("normal").records = initial.rows.map(row => {
    const { 工时, ...rest } = row.fields;
    return { record_id: `rec${++n}`, fields: { ...rest, "工时（小时）": 工时 } };
  });
  let failAfterCreate = "";
  function client(tableId) {
    return {
      tableId, fieldMap: null,
      async resolveAppToken() { return "app"; },
      async listFields() { this.fieldMap = tables.get(tableId).fields; return this.fieldMap; },
      async createField(f) { const field = { ...f, field_id: `fld${++n}` }; tables.get(tableId).fields.set(f.field_name, field); return field; },
      async updateField(id, field) { tables.get(tableId).fields.set(field.field_name, { ...field, field_id: id }); },
      async listRecords() { return structuredClone(tables.get(tableId).records); },
      serializeFields(f) { return f; },
      async batchCreate(rows) {
        const made = rows.map(r => ({ record_id: `rec${++n}`, fields: structuredClone(r.fields) }));
        tables.get(tableId).records.push(...made);
        if (failAfterCreate === tableId && rows.length) { failAfterCreate = ""; throw new Error("response lost"); }
        return made;
      },
      async batchUpdate(rows) { for (const row of rows) Object.assign(tables.get(tableId).records.find(r => r.record_id === row.recordId).fields, row.fields); },
      async batchDelete(ids) { tables.get(tableId).records = tables.get(tableId).records.filter(r => !ids.includes(r.record_id)); },
      async listTables() { return [...tables].map(([id, table]) => ({ table_id: id, name: table.name })); },
      async createTable(name, f) {
        const id = `tbl${++n}`;
        tables.set(id, { name, records: [], fields: new Map(f.map(x => [x.field_name, { ...x, field_id: `fld${++n}` }])) });
        return { table_id: id };
      },
    };
  }
  const calls = [];
  const jira = { ...jiraBase, async fetchPlansRange(from, to) { calls.push([from,to]); return structuredClone(plans.filter(p => p.day >= from && p.day <= to)); } };
  const config = { stateFile: path.join(dir, "state.json"), feishuTableId: "raw", feishuDailyTableId: "normal",
    feishuBackfillTemplateTableId: "template", feishuDailyHoursField: "工时（小时）", syncWriteEnabled: true, syncAllowedHostname: os.hostname() };
  const service = createAssignmentService(config, { jira, client, now: () => clock });
  return { service, tables, calls, config, setPlans(p) { plans = p; }, setDate(d) { clock = new Date(`${d}T00:00:00Z`); },
    fail(table) { failAfterCreate = table; }, state: async () => JSON.parse(await fs.readFile(config.stateFile, "utf8")),
    async init() { const p = await service.preview("2026-09-19"); await service.initialize("2026-09-19", p.baseline.hash); } };
}

test("daily changes remain pending historically, monthly writes net delta once and creates next month's table", async t => {
  const f = await fixture(t); await f.init();
  f.setDate("2026-09-21");
  f.setPlans([plan(1,"2026-08-10",8),plan(2,"2026-09-18",4)]);
  // August 10 is intentionally outside daily window: first observed at monthly full scan.
  await f.service.sync("2026-09-20");
  assert.equal(f.tables.get("normal").records.find(r=>r.fields["日期"]==="2026-08-10").fields["工时（小时）"],5);
  assert.equal(f.tables.get("normal").records.find(r=>r.fields["日期"]==="2026-09-18").fields["工时（小时）"],4);
  assert.equal(f.tables.get("template").records.length,0);
  f.setDate("2026-09-22");
  f.setPlans([plan(1,"2026-08-10",6),plan(2,"2026-09-18",4)]);
  f.fail("template");
  await assert.rejects(f.service.sync("2026-09-21"), /response lost/);
  assert.ok((await f.state()).assignment.pending);
  await f.service.sync("2026-09-21");
  await f.service.sync("2026-09-21");
  assert.equal(f.tables.get("template").records.length,1);
  assert.equal(f.tables.get("template").records[0].fields["补录工时（小时）"],1);
  assert.equal((await f.state()).assignment.closedThrough,"2026-09-21");
  f.setDate("2026-10-22");
  f.setPlans([plan(1,"2026-08-10",3),plan(2,"2026-09-18",4)]);
  await f.service.sync("2026-10-21");
  const oct = [...f.tables.values()].find(t=>t.name==="工时信息-补录-10月");
  assert.equal(oct.records[0].fields["补录工时（小时）"],-3);
  await f.service.sync("2026-10-21");
  assert.equal(oct.records.length,1);
});

test("lost log create response recovers without duplicate event and normal deletion removes only its contribution", async t => {
  const f = await fixture(t); await f.init(); f.setDate("2026-09-21");
  f.setPlans([plan(1,"2026-08-10",5),plan(3,"2026-09-18",3)]);
  f.fail("raw");
  await assert.rejects(f.service.sync("2026-09-20"), /response lost/);
  const count = f.tables.get("raw").records.length;
  await f.service.sync("2026-09-20");
  assert.equal(f.tables.get("raw").records.length,count);
  const normal = f.tables.get("normal").records.find(r=>r.fields["日期"]==="2026-09-18");
  assert.equal(normal.fields["工时（小时）"],3);
  assert.equal(normal.fields["派工识别id"],"320260918");
  assert.ok(f.calls.some(([from])=>from==="2026-01-01"));
});

test("initialization blocks unknown history and a stale baseline approval", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.sync("2026-09-19"), /尚未初始化/);
  await assert.rejects(f.service.initialize("2026-09-19","wrong"), /摘要/);
  f.setPlans([plan(1,"2026-08-10",9),plan(2,"2026-09-18",2)]);
  const p = await f.service.preview("2026-09-19");
  assert.equal(p.baseline.differences.length,1);
  await assert.rejects(f.service.initialize("2026-09-19",p.baseline.hash), /历史基线/);
  assert.equal(f.tables.get("template").records.length,0);
});

test("month's observed changes in daily window are not consumed before monthly accounting", async t => {
  const f = await fixture(t);
  f.setPlans([plan(1,"2026-08-21",5),plan(2,"2026-09-18",2)]);
  f.tables.get("normal").records.find(r=>r.fields["日期"]==="2026-08-10").fields["日期"]="2026-08-21";
  await f.init(); f.setDate("2026-09-20");
  f.setPlans([plan(1,"2026-08-21",8),plan(2,"2026-09-18",2)]);
  await f.service.sync("2026-09-19");
  const a = (await f.state()).assignment;
  assert.equal(a.observed["1|2026-08-21"].daily.fields["工时"],8);
  assert.equal(a.accounted["1|2026-08-21"].daily.fields["工时"],5);
  f.setDate("2026-09-22");
  f.setPlans([plan(1,"2026-08-21",6),plan(2,"2026-09-18",2)]);
  await f.service.sync("2026-09-21");
  assert.equal(f.tables.get("template").records[0].fields["补录工时（小时）"],1);
});
