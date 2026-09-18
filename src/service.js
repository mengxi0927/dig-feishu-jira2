import { FeishuClient } from "./feishu.js";
import { requireConfig } from "./env.js";
import { JiraClient } from "./jira.js";
import { StateStore } from "./state.js";
import { EXPECTED_FIELDS, transformPlans } from "./transform.js";

export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("date 必须是 YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date 不是有效日期");
  }
  return date;
}

export function createSyncService(config) {
  requireConfig(config, ["jiraBaseUrl", "jiraUsername", "jiraPassword"]);
  const jira = new JiraClient({
    baseUrl: config.jiraBaseUrl,
    username: config.jiraUsername,
    password: config.jiraPassword,
  });

  async function preview(date) {
    validateDate(date);
    const plans = await jira.fetchPlanAllocationsForDate(date);
    const rows = await transformPlans(plans, jira);
    return {
      date,
      jiraRecords: plans.length,
      rows: rows.length,
      data: rows.map(({ sourceKey, sourceDay, fields }) => ({ sourceKey, sourceDay, fields })),
    };
  }

  async function sync(date) {
    requireConfig(config, ["feishuAppId", "feishuAppSecret", "feishuTableId"]);
    const result = await preview(date);
    const feishu = new FeishuClient({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      appToken: config.feishuAppToken,
      wikiNodeToken: config.feishuWikiNodeToken,
      tableId: config.feishuTableId,
      timezoneOffset: config.timezoneOffset,
    });
    const fieldMap = await feishu.listFields();
    const missingFields = EXPECTED_FIELDS.filter((name) => !fieldMap.has(name));
    if (config.strictFieldCheck && missingFields.length) {
      throw new Error(`飞书表缺少 Excel 中的字段：${missingFields.join(", ")}`);
    }

    const appToken = await feishu.resolveAppToken();
    const state = await new StateStore(config.stateFile).load();
    const tableState = state.table(appToken, config.feishuTableId);
    const creates = [];
    const updates = [];
    const sourceKeys = new Set();

    for (const row of result.data) {
      sourceKeys.add(row.sourceKey);
      const fields = feishu.serializeFields(row.fields);
      const known = tableState.records[row.sourceKey];
      const recordId = typeof known === "string" ? known : known?.recordId;
      if (recordId) updates.push({ sourceKey: row.sourceKey, sourceDay: row.sourceDay, recordId, fields });
      else creates.push({ sourceKey: row.sourceKey, sourceDay: row.sourceDay, fields });
    }

    if (updates.length) await feishu.batchUpdate(updates);
    const created = creates.length ? await feishu.batchCreate(creates) : [];
    if (created.length !== creates.length) {
      throw new Error(`飞书新增返回 ${created.length} 条，预期 ${creates.length} 条，未更新本地状态`);
    }
    for (let index = 0; index < creates.length; index += 1) {
      const recordId = created[index]?.record_id;
      if (!recordId) throw new Error(`第 ${index + 1} 条飞书新增记录缺少 record_id`);
      tableState.records[creates[index].sourceKey] = {
        recordId,
        day: creates[index].sourceDay,
      };
    }

    for (const row of updates) {
      tableState.records[row.sourceKey] = { recordId: row.recordId, day: row.sourceDay };
    }

    const deletions = [];
    if (config.deleteMissing) {
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

    await state.save();
    return {
      date,
      jiraRecords: result.jiraRecords,
      rows: result.rows,
      created: creates.length,
      updated: updates.length,
      deleted: deletions.length,
      missingFields,
      appTokenResolved: true,
      tableId: config.feishuTableId,
    };
  }

  return { preview, sync };
}
