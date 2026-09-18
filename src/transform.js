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
];

function hours(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "";
  return Number(seconds) / 3600;
}

function locationName(location) {
  if (location == null) return "";
  if (typeof location === "string") return location;
  return location.name || location.displayName || location.label || JSON.stringify(location);
}

export async function transformPlans(plans, jiraClient) {
  const projects = await jiraClient.getProjectNames();
  const accountIds = [...new Set(plans.flatMap((plan) => [plan.assignee, plan.planCreator]).filter(Boolean))];
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
        "Assignee (Full name)": displayNames.get(plan.assignee) || plan.assignee || "",
        "Assignee (Account ID)": plan.assignee || "",
        "Planned by (Full name)": displayNames.get(plan.planCreator) || plan.planCreator || "",
        "Planned by (Account ID)": plan.planCreator || "",
        "Reviewer (Full name)": "",
        "Reviewer (Account ID)": "",
        "Approval status": "",
        "Approval status date": "",
        "Approved by (Full name)": "",
        "Approved by (Account ID)": "",
        "Approval date and time": "",
        "Location Name": locationName(plan.location),
      },
    });
  }
  return transformed;
}
