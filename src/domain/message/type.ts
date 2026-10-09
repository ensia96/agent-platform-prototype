export namespace MessageType {
  export type Status = "streaming" | TerminalStatus;

  export type StoppedStatus = "cancelled" | "interrupted";

  export type TerminalStatus = "completed" | "failed" | StoppedStatus;
}
