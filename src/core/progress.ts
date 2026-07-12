export type AgentProgressEvent =
  | { type: "assistant_text"; delta: string }
  | { type: "tool_status"; message: string };

export type AgentProgressSink = (
  event: AgentProgressEvent,
) => Promise<void> | void;
