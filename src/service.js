import { FeishuClient } from "./feishu.js";
import { requireConfig } from "./env.js";
import { JiraClient } from "./jira.js";
import { StateStore } from "./state.js";
import { withSyncWriteGuard } from "./sync-guard.js";
import { createAssignmentService } from "./assignment-service.js";
import {
  DAILY_EXPECTED_FIELDS,
  EXPECTED_FIELDS,
  transformDailyPlans,
  transformPlans,
} from "./transform.js";

export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("date 必须是 YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date 不是有效日期");
  }
  return date;
}

function createFeishuClient(config, tableId) {
  return new FeishuClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    appToken: config.feishuAppToken,
    wikiNodeToken: config.feishuWikiNodeToken,
    tableId,
    timezoneOffset: config.timezoneOffset,
  });
}

async function validateTableFields(feishu, expectedFields, strictFieldCheck, tableLabel) {
  const fieldMap = feishu.fieldMap || await feishu.listFields();
  const missingFields = expectedFields.filter((name) => !fieldMap.has(name));
  if (strictFieldCheck && missingFields.length) {
    throw new Error(`飞书${tableLabel}缺少字段：${missingFields.join(", ")}`);
  }
  return missingFields;
}

export async function syncTableRows({
  feishu,
  rows,
  expectedFields,
  state,
  date,
  deleteMissing,
  strictFieldCheck,
  tableLabel,
}) {
  const missingFields = await validateTableFields(
    feishu,
    expectedFields,
    strictFieldCheck,
    tableLabel,
  );

  const appToken = await feishu.resolveAppToken();
  const tableState = state.table(appToken, feishu.tableId);
  const creates = [];
  const updates = [];
  const sourceKeys = new Set();

  for (const row of rows) {
    sourceKeys.add(row.sourceKey);
    const fields = feishu.serializeFields(row.fields);
    const known = tableState.records[row.sourceKey];
    const recordId = typeof known === "string" ? known : known?.recordId;
    if (recordId) updates.push({ ...row, recordId, fields });
    else creates.push({ ...row, fields });
  }

  if (updates.length) await feishu.batchUpdate(updates);
  const created = creates.length ? await feishu.batchCreate(creates) : [];
  if (created.length !== creates.length) {
    throw new Error(`飞书${tableLabel}新增返回 ${created.length} 条，预期 ${creates.length} 条，未更新本地状态`);
  }

  for (let index = 0; index < creates.length; index += 1) {
    const recordId = created[index]?.record_id;
    if (!recordId) throw new Error(`飞书${tableLabel}第 ${index + 1} 条新增记录缺少 record_id`);
    tableState.records[creates[index].sourceKey] = {
      recordId,
      day: creates[index].sourceDay,
    };
  }

  for (const row of updates) {
    tableState.records[row.sourceKey] = { recordId: row.recordId, day: row.sourceDay };
  }

  const deletions = [];
  if (deleteMissing) {
    for (const [sourceKey, known] of Object.entries(tableState.records)) {
      const knownDay = typeof known === "string" ? "" : known.day;
      const recordId = typeof known === "string" ? known : known.recordId;
      if (knownDay === date && !sourceKeys.has(sourceKey) && recordId) {
        deletions.push({ sourceKey, recordId });
      }
    }
    if (deletions.length) {
      await feishu.batchDelete(deletions.map((item) => item.recordId));
      for (const item of deletions) delete tableState.records[item.sourceKey];
    }
  }

  return {
    rows: rows.length,
    created: creates.length,
    updated: updates.length,
    deleted: deletions.length,
    missingFields,
    tableId: feishu.tableId,
    appToken,
  };
}

export function createSyncService(config) {
  requireConfig(config, ["jiraBaseUrl", "jiraUsername", "jiraPassword"]);
  if (config.assignmentStrategy === "monthly-delta") return createAssignmentService(config);
  if (config.assignmentStrategy && config.assignmentStrategy !== "legacy") throw new Error("未知 ASSIGNMENT_STRATEGY");
  const jira = new JiraClient({
    baseUrl: config.jiraBaseUrl,
    username: config.jiraUsername,
    password: config.jiraPassword,
  });

  async function preview(date) {
    validateDate(date);
    const plans = await jira.fetchPlanAllocationsForDate(date);
    const rows = await transformPlans(plans, jira);
    const daily = await transformDailyPlans(plans, jira);
    return {
      date,
      jiraRecords: plans.length,
      rows: rows.length,
      data: rows.map(({ sourceKey, sourceDay, fields }) => ({ sourceKey, sourceDay, fields })),
      daily: {
        ...daily.summary,
        errors: daily.errors,
        data: daily.rows,
      },
    };
  }

  async function sync(date) {
    requireConfig(config, [
      "feishuAppId",
      "feishuAppSecret",
      "feishuTableId",
      "feishuDailyTableId",
    ]);
    if (config.feishuTableId === config.feishuDailyTableId) {
      throw new Error("FEISHU_TABLE_ID 与 FEISHU_DAILY_TABLE_ID 不能相同");
    }
    const result = await preview(date);
    if (config.strictDailyGovernance && result.daily.errors.length) {
      const examples = result.daily.errors
        .slice(0, 3)
        .map((error) => `#${error.sourceIndex} ${error.codes.join("+")}`)
        .join(", ");
      throw new Error(
        `日粒度治理发现 ${result.daily.errors.length} 条异常，已停止写入：${examples}`,
      );
    }

    const rawFeishu = createFeishuClient(config, config.feishuTableId);
    const dailyFeishu = createFeishuClient(config, config.feishuDailyTableId);
    const hoursField = config.feishuDailyHoursField || "工时";
    if (["日期", "姓名", "项目号"].includes(hoursField)) {
      throw new Error("FEISHU_DAILY_HOURS_FIELD 不能与日粒度主键字段重名");
    }
    const dailyExpectedFields = DAILY_EXPECTED_FIELDS.map((name) => name === "工时" ? hoursField : name);
    const dailyRows = result.daily.data.map((row) => {
      const { 工时: hours, ...fields } = row.fields;
      return { ...row, fields: { ...fields, [hoursField]: hours } };
    });
    // Validate both schemas before either table is mutated.
    await validateTableFields(
      rawFeishu,
      EXPECTED_FIELDS,
      config.strictFieldCheck,
      "派工基础表",
    );
    await validateTableFields(
      dailyFeishu,
      dailyExpectedFields,
      config.strictFieldCheck,
      "日粒度表",
    );

    const state = await new StateStore(config.stateFile).load();
    const rawTable = await syncTableRows({
      feishu: rawFeishu,
      rows: result.data,
      expectedFields: EXPECTED_FIELDS,
      state,
      date,
      deleteMissing: config.deleteMissing,
      strictFieldCheck: config.strictFieldCheck,
      tableLabel: "派工基础表",
    });
    await state.save();

    const dailyTable = await syncTableRows({
      feishu: dailyFeishu,
      rows: dailyRows,
      expectedFields: dailyExpectedFields,
      state,
      date,
      deleteMissing: config.dailyDeleteMissing,
      strictFieldCheck: config.strictFieldCheck,
      tableLabel: "日粒度表",
    });
    await state.save();

    const dailyPreview = { ...result.daily };
    delete dailyPreview.data;
    return {
      date,
      jiraRecords: result.jiraRecords,
      rows: result.rows,
      created: rawTable.created,
      updated: rawTable.updated,
      deleted: rawTable.deleted,
      missingFields: rawTable.missingFields,
      appTokenResolved: true,
      tableId: config.feishuTableId,
      daily: {
        ...dailyPreview,
        created: dailyTable.created,
        updated: dailyTable.updated,
        deleted: dailyTable.deleted,
        missingFields: dailyTable.missingFields,
        tableId: config.feishuDailyTableId,
      },
    };
  }

  return { preview, sync: (date) => withSyncWriteGuard(config, () => sync(date)) };
}
