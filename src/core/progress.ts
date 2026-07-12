/** A runtime-owned, sanitized status that is safe to display before a turn completes. */
export interface AgentProgressEvent {
  type: "tool_status";
  message: string;
}

export type AgentProgressSink = (
  event: AgentProgressEvent,
) => Promise<void> | void;
