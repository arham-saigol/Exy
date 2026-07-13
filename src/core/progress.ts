/** Runtime-owned user-visible output that is safe to display before a turn completes. */
export type AgentProgressEvent = {
  type: "tool_status";
  message: string;
} | {
  /** A complete model-authored assistant message, never a token delta. */
  type: "assistant_text";
  message: string;
};

export type AgentProgressSink = (
  event: AgentProgressEvent,
) => Promise<void> | void;
