export namespace RunType {
  export type ActiveStatus = "cancelling" | "running" | WaitingStatus;

  export type Status = ActiveStatus | TerminalStatus;

  export type StoppedStatus = "cancelled" | "interrupted";

  export type TerminalStatus = "completed" | "failed" | StoppedStatus;

  export type WaitingStatus = "waiting_children" | "waiting_permission";
}
