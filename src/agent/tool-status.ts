const TOOL_STATUSES: Readonly<Record<string, string>> = {
  search_x: "Searching X",
  recommend_reply_opportunity: "Checking this reply opportunity",
  search_web: "Searching the web",
  fetch_web_page: "Reading a web page",
  search_memory: "Reviewing our past conversations",
  store_memory: "Saving this for later",
  render_original_post_draft: "Preparing your X draft",
  prepare_x_publication: "Preparing your X post for approval",
  publish_approved_x: "Publishing your approved X post",
  inspect_x_account: "Looking at your X profile",
  list_x_post_history: "Reviewing past posts",
  inspect_x_publication_status: "Checking your X post status",
  list_agent_skills: "Checking available capabilities",
  activate_agent_skill: "Loading the right workflow",
  read_agent_skill_resource: "Reviewing workflow guidance",
  create_scheduled_job: "Scheduling that work",
  list_scheduled_jobs: "Reviewing scheduled work",
  update_scheduled_job: "Updating scheduled work",
  remove_scheduled_job: "Removing scheduled work",
  inspect_scheduled_job_history: "Reviewing automation history",
  inspect_heartbeat: "Checking recurring work",
  update_heartbeat: "Updating recurring work",
};

/**
 * Convert internal tool activity to a short, safe status. Tool arguments are
 * deliberately used only for allowlisted enum branches and are never rendered.
 */
export function formatToolStatus(toolName: string, args: unknown): string {
  if (toolName === "inspect_x_analytics") {
    return analyticsMode(args) === "followers"
      ? "Viewing follower analytics"
      : "Viewing X analytics";
  }
  return TOOL_STATUSES[toolName] ?? "Working on the next step";
}

function analyticsMode(args: unknown): "followers" | "posts" | undefined {
  if (typeof args !== "object" || args === null || !("mode" in args)) return undefined;
  const mode = (args as { mode?: unknown }).mode;
  return mode === "followers" || mode === "posts" ? mode : undefined;
}
