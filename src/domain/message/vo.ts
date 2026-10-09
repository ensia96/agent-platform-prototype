import { ValueObject } from "@/_/vo";
import { MESSAGE_CONSTANT } from "@/message/constant";
import { MessageType } from "@/message/type";

export namespace MessageVO {
  export class Status extends ValueObject<MessageType.Status> {
    static isStreaming(value: unknown): value is "streaming" {
      return value === "streaming";
    }

    static looksLike(value: unknown): value is MessageType.Status {
      return Status.isStreaming(value) || TerminalStatus.looksLike(value);
    }

    protected validate(value: unknown): value is MessageType.Status {
      return Status.looksLike(value);
    }

    isCompleted(): this is this & { value: "completed" } {
      return this.isValid() && TerminalStatus.isCompleted(this.value);
    }

    isFailed(): this is this & { value: "failed" } {
      return this.isValid() && TerminalStatus.isFailed(this.value);
    }

    isStopped(): this is this & { value: MessageType.StoppedStatus } {
      return this.isValid() && StoppedStatus.looksLike(this.value);
    }

    isStreaming(): this is this & { value: "streaming" } {
      return this.isValid() && Status.isStreaming(this.value);
    }

    isTerminal(): this is this & { value: MessageType.TerminalStatus } {
      return this.isValid() && TerminalStatus.looksLike(this.value);
    }
  }

  export class StoppedStatus extends ValueObject<MessageType.StoppedStatus> {
    static looksLike(value: unknown): value is MessageType.StoppedStatus {
      return MESSAGE_CONSTANT.STOPPED_STATUS.includes(
        value as MessageType.StoppedStatus,
      );
    }

    protected validate(value: unknown): value is MessageType.StoppedStatus {
      return StoppedStatus.looksLike(value);
    }
  }

  export class TerminalStatus extends ValueObject<MessageType.TerminalStatus> {
    static isCompleted(value: unknown): value is "completed" {
      return value === "completed";
    }

    static isFailed(value: unknown): value is "failed" {
      return value === "failed";
    }

    static looksLike(value: unknown): value is MessageType.TerminalStatus {
      return (
        TerminalStatus.isCompleted(value) ||
        TerminalStatus.isFailed(value) ||
        StoppedStatus.looksLike(value)
      );
    }

    protected validate(value: unknown): value is MessageType.TerminalStatus {
      return TerminalStatus.looksLike(value);
    }

    isCompleted(): this is this & { value: "completed" } {
      return this.isValid() && TerminalStatus.isCompleted(this.value);
    }

    isFailed(): this is this & { value: "failed" } {
      return this.isValid() && TerminalStatus.isFailed(this.value);
    }

    isStopped(): this is this & { value: MessageType.StoppedStatus } {
      return this.isValid() && StoppedStatus.looksLike(this.value);
    }
  }
}
