export const EXPECTED_FIELDS = [
  "From date",
  "To date",
  "Start time",
  "Project key",
  "Project name",
  "Issue key",
  "Issue summary",
  "Planned hours per day",
  "Number of planned days",
  "Planned hours total",
  "Description",
  "Assignee (Full name)",
  "Assignee (Account ID)",
  "Planned by (Full name)",
  "Planned by (Account ID)",
  "Reviewer (Full name)",
  "Reviewer (Account ID)",
  "Approval status",
  "Approval status date",
  "Approved by (Full name)",
  "Approved by (Account ID)",
  "Approval date and time",
  "Location Name",
  "Sync status",
  "Source",
  "Jira Tempo PlanningIssue URL",
  "Jira IssuePlan item type",
  "dateCreated",
  "dateUpdated",
  "派工状态",
  "allocationId",
  "派工识别id",
];

export const DAILY_EXPECTED_FIELDS = ["日期", "姓名", "项目号", "工时", "派工识别id"];

function hours(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "";
  return Number(seconds) / 3600;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function identifier(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value !== "object") return "";
  return String(
    value.accountId
      || value.userKey
      || value.key
      || value.username
      || value.name
      || value.id
      || "",
  ).trim();
}

function projectKey(plan) {
  const info = plan?.planItemInfo || {};
  if (info.projectKey) return String(info.projectKey).trim();
  const issueKey = String(info.key || "").trim();
  const match = issueKey.match(/^(.+)-\d+$/);
  return match ? match[1] : "";
}

function roundHours(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function dailySourceKey(day, project, assigneeName) {
  // JSON tuple avoids collisions when a name or project key contains a separator.
  return JSON.stringify([day, project, assigneeName]);
}

function locationName(location) {
  if (location == null) return "";
  if (typeof location === "string") return location;
  return location.name || location.displayName || location.label || JSON.stringify(location);
}

export async function transformPlans(plans, jiraClient) {
  const projects = await jiraClient.getProjectNames();
  const accountIds = [
    ...new Set(
      plans
        .flatMap((plan) => [identifier(plan.assignee), identifier(plan.planCreator)])
        .filter(Boolean),
    ),
  ];
  const displayNames = new Map();

  for (const accountId of accountIds) {
    displayNames.set(accountId, await jiraClient.getUserDisplayName(accountId));
  }

  const seen = new Set();
  const transformed = [];
  for (const plan of plans) {
    const sourceKey = `${plan.allocationId}|${plan.day}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    const info = plan.planItemInfo || {};
    const projectKey = info.projectKey || "";
    const assigneeId = identifier(plan.assignee);
    const creatorId = identifier(plan.planCreator);
    const itemType = plan.planItemType || "";
    const issueKey = String(info.key || "").trim();
    const isIssue = itemType ? String(itemType).toUpperCase() === "ISSUE" : /^.+-\d+$/.test(issueKey);
    const issueUrl = isIssue && issueKey && jiraClient.baseUrl
      ? `${jiraClient.baseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(issueKey)}`
      : "";
    transformed.push({
      sourceKey,
      sourceDay: plan.day,
      fields: {
        "From date": plan.planStart || plan.day || "",
        "To date": plan.planEnd || plan.day || "",
        "Start time": plan.planStartTime || "",
        "Project key": projectKey,
        "Project name": projects.get(projectKey) || "",
        "Issue key": info.key || "",
        "Issue summary": info.summary || info.name || "",
        "Planned hours per day": hours(plan.secondsPerDay),
        "Number of planned days": plan._plannedDayCount ?? 1,
        "Planned hours total": hours(plan._plannedSecondsTotal ?? plan.timePlannedSeconds),
        Description: plan.planDescription || "",
        "Assignee (Full name)": displayNames.get(assigneeId) || assigneeId,
        "Assignee (Account ID)": assigneeId,
        "Planned by (Full name)": displayNames.get(creatorId) || creatorId,
        "Planned by (Account ID)": creatorId,
        "Reviewer (Full name)": "",
        "Reviewer (Account ID)": "",
        "Approval status": "",
        "Approval status date": "",
        "Approved by (Full name)": "",
        "Approved by (Account ID)": "",
        "Approval date and time": "",
        "Location Name": locationName(plan.location),
        "Sync status": "已同步",
        Source: "Jira Tempo Planning",
        "Jira Tempo PlanningIssue URL": issueUrl,
        "Jira IssuePlan item type": itemType,
        dateCreated: plan.dateCreated || "",
        dateUpdated: plan.dateUpdated || "",
        allocationId: identifier(plan.allocationId),
        "派工识别id": sourceKey,
      },
    });
  }
  return transformed;
}

/**
 * Convert Tempo's already-expanded daily plan rows into the governed table.
 * Several allocations/issues for the same date + project + person are summed
 * into one row. timePlannedSeconds is the authoritative daily amount; older
 * Tempo responses that omit it fall back to secondsPerDay.
 */
export async function transformDailyPlans(plans, jiraClient, { includeAllocationIds = false } = {}) {
  const assigneeIds = [...new Set(plans.map((plan) => identifier(plan.assignee)).filter(Boolean))];
  const displayNames = new Map();
  for (const accountId of assigneeIds) {
    displayNames.set(accountId, await jiraClient.getUserDisplayName(accountId));
  }

  const groups = new Map();
  const errors = [];
  const seenAllocationDays = new Set();
  let duplicatePlans = 0;
  let acceptedPlans = 0;
  let acceptedSeconds = 0;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index] || {};
    const info = plan.planItemInfo || {};
    const day = String(plan.day || "").trim();
    const project = projectKey(plan);
    const assigneeId = identifier(plan.assignee);
    const allocationId = identifier(plan.allocationId ?? plan.id ?? plan.planId);
    const directSeconds = finiteNumber(plan.timePlannedSeconds);
    const fallbackSeconds = finiteNumber(plan.secondsPerDay);
    const plannedSeconds = directSeconds ?? fallbackSeconds;
    const codes = [];

    if (!validDay(day)) codes.push("INVALID_DAY");
    if (!project) codes.push("MISSING_PROJECT_KEY");
    if (!assigneeId) codes.push("MISSING_ASSIGNEE");
    if (plannedSeconds == null || plannedSeconds < 0) codes.push("INVALID_PLANNED_SECONDS");

    if (codes.length) {
      errors.push({
        sourceIndex: index + 1,
        allocationId,
        issueKey: String(info.key || ""),
        codes,
      });
      continue;
    }

    if (allocationId) {
      const contributionKey = `${allocationId}|${day}`;
      if (seenAllocationDays.has(contributionKey)) {
        duplicatePlans += 1;
        continue;
      }
      seenAllocationDays.add(contributionKey);
    }

    const assigneeName = String(displayNames.get(assigneeId) || assigneeId).trim();
    if (!assigneeName) {
      errors.push({
        sourceIndex: index + 1,
        allocationId,
        issueKey: String(info.key || ""),
        codes: ["MISSING_ASSIGNEE_NAME"],
      });
      continue;
    }

    const sourceKey = dailySourceKey(day, project, assigneeName);
    const group = groups.get(sourceKey) || {
      sourceKey,
      sourceDay: day,
      day,
      project,
      assigneeName,
      seconds: 0,
      allocationIds: new Set(),
    };
    group.seconds += plannedSeconds;
    if (allocationId) group.allocationIds.add(allocationId);
    groups.set(sourceKey, group);
    acceptedPlans += 1;
    acceptedSeconds += plannedSeconds;
  }

  const rows = [...groups.values()]
    .map((group) => ({
      sourceKey: group.sourceKey,
      sourceDay: group.sourceDay,
      fields: {
        "日期": group.day,
        "姓名": group.assigneeName,
        "项目号": group.project,
        "工时": roundHours(group.seconds / 3600),
        ...(includeAllocationIds ? { "派工识别id": [...group.allocationIds].sort().map(id => `${id}|${group.day}`).join(",") } : {}),
      },
    }))
    .sort((left, right) => (
      left.sourceDay.localeCompare(right.sourceDay)
      || left.fields["项目号"].localeCompare(right.fields["项目号"])
      || left.fields["姓名"].localeCompare(right.fields["姓名"], "zh-CN")
    ));

  return {
    rows,
    errors,
    summary: {
      inputPlans: plans.length,
      acceptedPlans,
      duplicatePlans,
      rejectedPlans: errors.length,
      outputRows: rows.length,
      inputHours: roundHours(acceptedSeconds / 3600),
      outputHours: roundHours(rows.reduce((total, row) => total + row.fields["工时"], 0)),
    },
  };
}
