import { MessageType } from "@/message/type";

export namespace MESSAGE_CONSTANT {
  export const STOPPED_STATUS: MessageType.StoppedStatus[] = [
    "cancelled",
    "interrupted",
  ];

  export const TERMINAL_STATUS: MessageType.TerminalStatus[] = [
    "completed",
    "failed",
    ...STOPPED_STATUS,
  ];
}
