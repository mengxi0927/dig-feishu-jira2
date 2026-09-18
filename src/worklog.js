export const WORKLOG_EXPECTED_FIELDS = [
  "问题关键字",
  "问题主题",
  "工时",
  "工作日期",
  "用户名",
  "全名",
  "周期",
  "账户关键字",
  "账户名称",
  "Account Lead",
  "Account Category",
  "Account Customer",
  "活动名称",
  "组件",
  "全部组件",
  "版本名称",
  "问题类型",
  "问题状态",
  "项目关键字",
  "项目名称",
  "Epic",
  "Epic Link",
  "工作描述",
  "父问题关键字",
  "报告人",
  "外部工时数",
  "有效工时数",
  "问题原估算时间",
  "问题剩余预估时间",
  "Location Name",
  "Account Approval Status",
  "Jira Worklog ID",
  "Jira Issue ID",
  "Worklog 更新时间",
  "同步时间",
];

function text(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return text(
      value.displayName
      || value.name
      || value.key
      || value.value
      || value.text
      || value.id
      || "",
    );
  }
  return "";
}

function roundHours(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function startedDay(started) {
  const match = String(started || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function estimateText(displayValue, seconds) {
  if (displayValue) return String(displayValue);
  if (seconds == null || seconds === "") return "";
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  return `${roundHours(numeric / 3600)}h`;
}

function projectKey(issue) {
  const direct = text(issue?.fields?.project?.key);
  if (direct) return direct;
  const match = String(issue?.key || "").match(/^(.+)-\d+$/);
  return match ? match[1] : "";
}

export function worklogSourceKey(worklogId) {
  return `worklog:${worklogId}`;
}

export function transformWorklogs(entries, options = {}) {
  const errors = [];
  const rows = [];
  const seen = new Set();
  let duplicateWorklogs = 0;
  let totalSeconds = 0;
  const syncTimestamp = options.syncTimestamp || Date.now();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] || {};
    const issue = entry.issue || {};
    const issueFields = issue.fields || {};
    const worklog = entry.worklog || {};
    const worklogId = text(worklog.id);
    const issueKey = text(issue.key);
    const day = startedDay(worklog.started);
    const author = worklog.author || {};
    const authorId = text(author.name || author.key || author.accountId);
    const seconds = Number(worklog.timeSpentSeconds);
    const codes = [];

    if (!worklogId) codes.push("MISSING_WORKLOG_ID");
    if (!issueKey) codes.push("MISSING_ISSUE_KEY");
    if (!validDay(day)) codes.push("INVALID_WORK_DATE");
    if (!authorId) codes.push("MISSING_AUTHOR");
    if (!Number.isFinite(seconds) || seconds <= 0) codes.push("INVALID_TIME_SPENT_SECONDS");

    if (codes.length) {
      errors.push({
        sourceIndex: index + 1,
        worklogId,
        issueKey,
        codes,
      });
      continue;
    }

    if (seen.has(worklogId)) {
      duplicateWorklogs += 1;
      continue;
    }
    seen.add(worklogId);

    const components = Array.isArray(issueFields.components) ? issueFields.components : [];
    const versions = Array.isArray(issueFields.fixVersions) ? issueFields.fixVersions : [];
    const project = issueFields.project || {};
    const timetracking = issueFields.timetracking || {};
    const hours = roundHours(seconds / 3600);
    const epicLink = options.epicLinkField ? text(issueFields[options.epicLinkField]) : "";
    const epicName = options.epicNameField ? text(issueFields[options.epicNameField]) : "";

    rows.push({
      sourceKey: worklogSourceKey(worklogId),
      sourceDay: day,
      fields: {
        "问题关键字": issueKey,
        "问题主题": text(issueFields.summary),
        "工时": hours,
        "工作日期": day,
        "用户名": text(author.emailAddress || author.name || author.key || author.accountId),
        "全名": text(author.displayName || author.name || author.key || author.accountId),
        "周期": "",
        "账户关键字": "",
        "账户名称": "",
        "Account Lead": "",
        "Account Category": "",
        "Account Customer": "",
        // Jira standard worklog has no Tempo Activity attribute; project name is the stable fallback.
        "活动名称": text(project.name),
        "组件": text(components[0]?.name),
        "全部组件": components.map((component) => text(component.name)).filter(Boolean).join(", "),
        "版本名称": versions.map((version) => text(version.name)).filter(Boolean).join(", "),
        "问题类型": text(issueFields.issuetype?.name),
        "问题状态": text(issueFields.status?.name),
        "项目关键字": projectKey(issue),
        "项目名称": text(project.name),
        "Epic": epicName,
        "Epic Link": epicLink,
        "工作描述": text(worklog.comment),
        "父问题关键字": text(issueFields.parent?.key),
        "报告人": text(issueFields.reporter?.name || issueFields.reporter?.key),
        "外部工时数": "",
        // Jira standard API does not expose Tempo billable seconds; use logged hours as a documented fallback.
        "有效工时数": hours,
        "问题原估算时间": estimateText(
          timetracking.originalEstimate,
          issueFields.timeoriginalestimate,
        ),
        "问题剩余预估时间": estimateText(
          timetracking.remainingEstimate,
          issueFields.timeestimate,
        ),
        "Location Name": "",
        "Account Approval Status": "",
        "Jira Worklog ID": worklogId,
        "Jira Issue ID": text(worklog.issueId || issue.id),
        "Worklog 更新时间": text(worklog.updated),
        "同步时间": syncTimestamp,
      },
    });
    totalSeconds += seconds;
  }

  rows.sort((left, right) => (
    left.sourceDay.localeCompare(right.sourceDay)
    || left.fields["项目关键字"].localeCompare(right.fields["项目关键字"])
    || left.fields["全名"].localeCompare(right.fields["全名"], "zh-CN")
    || left.fields["Jira Worklog ID"].localeCompare(right.fields["Jira Worklog ID"])
  ));

  return {
    rows,
    errors,
    summary: {
      inputWorklogs: entries.length,
      acceptedWorklogs: rows.length,
      duplicateWorklogs,
      rejectedWorklogs: errors.length,
      outputRows: rows.length,
      outputHours: roundHours(totalSeconds / 3600),
    },
  };
}
