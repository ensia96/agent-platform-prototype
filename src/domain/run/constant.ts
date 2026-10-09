import { RunType } from "@/run/type";

export namespace RUN_CONSTANT {
  export const STOPPED_STATUS: RunType.StoppedStatus[] = [
    "cancelled",
    "interrupted",
  ];

  export const WAITING_STATUS: RunType.WaitingStatus[] = [
    "waiting_children",
    "waiting_permission",
  ];

  export const ACTIVE_STATUS: RunType.ActiveStatus[] = [
    "cancelling",
    "running",
    ...WAITING_STATUS,
  ];

  export const TERMINAL_STATUS: RunType.TerminalStatus[] = [
    "completed",
    "failed",
    ...STOPPED_STATUS,
  ];
}
