import { FeishuClient } from "./feishu.js";
import { requireConfig } from "./env.js";
import { JiraClient } from "./jira.js";
import { StateStore } from "./state.js";
import { syncTableRows, validateDate } from "./service.js";
import {
  transformWorklogs,
  WORKLOG_EXPECTED_FIELDS,
  worklogSourceKey,
} from "./worklog.js";

function rangeDates(from, to) {
  validateDate(from);
  validateDate(to);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) throw new Error("to 不能早于 from");
  const dates = [];
  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(",");
  if (typeof value === "object") {
    return cellText(value.text || value.value || value.name || value.id || "");
  }
  return "";
}

function timezoneOffsetMinutes(value) {
  const match = String(value || "+08:00").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 480;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function recordDay(value, timezoneOffset) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + timezoneOffsetMinutes(timezoneOffset) * 60000)
    .toISOString()
    .slice(0, 10);
}

export function createWorklogSyncService(config) {
  requireConfig(config, ["jiraBaseUrl", "jiraUsername", "jiraPassword"]);
  const jira = new JiraClient({
    baseUrl: config.jiraBaseUrl,
    username: config.jiraUsername,
    password: config.jiraPassword,
  });

  async function preview(from, to) {
    rangeDates(from, to);
    const fetched = await jira.fetchWorklogsRange(from, to, {
      extraJql: config.worklogJqlExtra,
      concurrency: config.worklogConcurrency,
      pageSize: config.worklogPageSize,
    });
    const transformed = transformWorklogs(fetched.records, {
      epicLinkField: fetched.epicLinkField,
      epicNameField: fetched.epicNameField,
    });
    return {
      from,
      to,
      jql: fetched.jql,
      issueCount: fetched.issues.length,
      ...transformed.summary,
      errors: transformed.errors,
      data: transformed.rows,
    };
  }

  async function sync(from, to) {
    requireConfig(config, [
      "feishuAppId",
      "feishuAppSecret",
      "feishuWorklogTableId",
    ]);
    const dates = rangeDates(from, to);
    const result = await preview(from, to);
    if (config.strictWorklogGovernance && result.errors.length) {
      const examples = result.errors
        .slice(0, 3)
        .map((error) => `#${error.sourceIndex} ${error.codes.join("+")}`)
        .join(", ");
      throw new Error(
        `报工治理发现 ${result.errors.length} 条异常，已停止写入：${examples}`,
      );
    }

    const feishu = new FeishuClient({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      appToken: config.feishuAppToken,
      wikiNodeToken: config.feishuWikiNodeToken,
      tableId: config.feishuWorklogTableId,
      timezoneOffset: config.timezoneOffset,
    });
    const fieldMap = await feishu.listFields();
    const missingFields = WORKLOG_EXPECTED_FIELDS.filter((name) => !fieldMap.has(name));
    if (config.strictFieldCheck && missingFields.length) {
      throw new Error(`飞书报工表缺少字段：${missingFields.join(", ")}`);
    }

    const appToken = await feishu.resolveAppToken();
    const existingRecords = await feishu.listRecords();
    const existingRecordIds = new Set(existingRecords.map((record) => record.record_id));
    const state = await new StateStore(config.stateFile).load();
    const tableState = state.table(appToken, config.feishuWorklogTableId);

    // Drop local pointers whose remote records no longer exist.
    for (const [sourceKey, known] of Object.entries(tableState.records)) {
      const recordId = typeof known === "string" ? known : known?.recordId;
      if (recordId && !existingRecordIds.has(recordId)) delete tableState.records[sourceKey];
    }

    let bootstrappedRecords = 0;
    const duplicateExistingWorklogIds = [];
    const seenExistingWorklogIds = new Map();
    for (const record of existingRecords) {
      const worklogId = cellText(record.fields?.["Jira Worklog ID"]);
      if (!worklogId) continue;
      const sourceKey = worklogSourceKey(worklogId);
      if (seenExistingWorklogIds.has(worklogId)) {
        duplicateExistingWorklogIds.push({
          worklogId,
          recordIds: [seenExistingWorklogIds.get(worklogId), record.record_id],
        });
        continue;
      }
      seenExistingWorklogIds.set(worklogId, record.record_id);
      if (!tableState.records[sourceKey]) bootstrappedRecords += 1;
      tableState.records[sourceKey] = {
        recordId: record.record_id,
        day: recordDay(record.fields?.["工作日期"], config.timezoneOffset),
      };
    }
    await state.save();

    const rowsByDay = new Map(dates.map((date) => [date, []]));
    for (const row of result.data) rowsByDay.get(row.sourceDay)?.push(row);
    const perDay = [];
    for (const date of dates) {
      const tableResult = await syncTableRows({
        feishu,
        rows: rowsByDay.get(date),
        expectedFields: WORKLOG_EXPECTED_FIELDS,
        state,
        date,
        deleteMissing: config.worklogDeleteMissing,
        strictFieldCheck: config.strictFieldCheck,
        tableLabel: "报工表",
      });
      await state.save();
      perDay.push({
        date,
        rows: tableResult.rows,
        created: tableResult.created,
        updated: tableResult.updated,
        deleted: tableResult.deleted,
      });
    }

    return {
      from,
      to,
      issueCount: result.issueCount,
      worklogs: result.outputRows,
      hours: result.outputHours,
      created: perDay.reduce((total, day) => total + day.created, 0),
      updated: perDay.reduce((total, day) => total + day.updated, 0),
      deleted: perDay.reduce((total, day) => total + day.deleted, 0),
      bootstrappedRecords,
      duplicateExistingWorklogIds,
      missingFields,
      tableId: config.feishuWorklogTableId,
      perDay,
    };
  }

  return { preview, sync };
}
