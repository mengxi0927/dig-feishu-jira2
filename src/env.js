import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function getConfig() {
  loadDotEnv();
  return {
    jiraBaseUrl: (process.env.JIRA_BASE_URL || "https://jira.scity.cn").replace(/\/$/, ""),
    jiraUsername: process.env.JIRA_USERNAME || "",
    jiraPassword: process.env.JIRA_PASSWORD || "",
    feishuAppId: process.env.FEISHU_APP_ID || "",
    feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
    feishuWikiNodeToken: process.env.FEISHU_WIKI_NODE_TOKEN || "",
    feishuAppToken: process.env.FEISHU_APP_TOKEN || "",
    feishuTableId: process.env.FEISHU_TABLE_ID || "",
    feishuDailyTableId: process.env.FEISHU_DAILY_TABLE_ID || "",
    feishuDailyHoursField: process.env.FEISHU_DAILY_HOURS_FIELD || "工时",
    assignmentStrategy: process.env.ASSIGNMENT_STRATEGY || "monthly-delta",
    feishuBackfillTemplateTableId: process.env.FEISHU_BACKFILL_TEMPLATE_TABLE_ID || "tblVEzscKMM0EGwh",
    feishuWorklogTableId: process.env.FEISHU_WORKLOG_TABLE_ID || "tblZjQL48vL9oOAZ",
    feishuWorklogHoursField: process.env.FEISHU_WORKLOG_HOURS_FIELD || "工时（小时）",
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    assignmentScheduleEnabled: booleanValue(process.env.ASSIGNMENT_SCHEDULE_ENABLED, false),
    worklogScheduleEnabled: booleanValue(process.env.WORKLOG_SCHEDULE_ENABLED, false),
    syncWriteEnabled: booleanValue(process.env.SYNC_WRITE_ENABLED, false),
    syncAllowedHostname: process.env.SYNC_ALLOWED_HOSTNAME || "",
    timezoneOffset: process.env.TIMEZONE_OFFSET || "+08:00",
    stateFile: path.resolve(process.cwd(), process.env.STATE_FILE || "./data/sync-state.json"),
    strictFieldCheck: booleanValue(process.env.STRICT_FIELD_CHECK, true),
    strictDailyGovernance: booleanValue(process.env.STRICT_DAILY_GOVERNANCE, true),
    deleteMissing: booleanValue(process.env.SYNC_DELETE_MISSING, false),
    dailyDeleteMissing: booleanValue(process.env.SYNC_DAILY_DELETE_MISSING, true),
    strictWorklogGovernance: booleanValue(process.env.STRICT_WORKLOG_GOVERNANCE, true),
    worklogDeleteMissing: booleanValue(process.env.WORKLOG_SYNC_DELETE_MISSING, true),
    worklogJqlExtra: process.env.WORKLOG_JQL_EXTRA || "",
    worklogConcurrency: Number(process.env.WORKLOG_CONCURRENCY || 6),
    worklogPageSize: Number(process.env.WORKLOG_PAGE_SIZE || 100),
  };
}

export function requireConfig(config, keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) throw new Error(`缺少配置：${missing.join(", ")}`);
}
