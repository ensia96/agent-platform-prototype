import { ValueObject } from "@/_/vo";
import { RUN_CONSTANT } from "@/run/constant";
import { RunType } from "@/run/type";

export namespace RunVO {
  export class ActiveStatus extends ValueObject<RunType.ActiveStatus> {
    static isCancelling(value: unknown): value is "cancelling" {
      return value === "cancelling";
    }

    static isRunning(value: unknown): value is "running" {
      return value === "running";
    }

    static looksLike(value: unknown): value is RunType.ActiveStatus {
      return (
        ActiveStatus.isCancelling(value) ||
        ActiveStatus.isRunning(value) ||
        WaitingStatus.looksLike(value)
      );
    }

    protected validate(value: unknown): value is RunType.ActiveStatus {
      return ActiveStatus.looksLike(value);
    }

    isCancelling(): this is this & { value: "cancelling" } {
      return this.isValid() && ActiveStatus.isCancelling(this.value);
    }

    isRunning(): this is this & { value: "running" } {
      return this.isValid() && ActiveStatus.isRunning(this.value);
    }

    isWaiting(): this is this & { value: RunType.WaitingStatus } {
      return this.isValid() && WaitingStatus.looksLike(this.value);
    }
  }

  export class Status extends ValueObject<RunType.Status> {
    static looksLike(value: unknown): value is RunType.Status {
      return ActiveStatus.looksLike(value) || TerminalStatus.looksLike(value);
    }

    protected validate(value: unknown): value is RunType.Status {
      return Status.looksLike(value);
    }

    canTransitionTo(target: Status) {
      return (
        this.isActive() &&
        target.isValid() &&
        (target.isStopped() ||
          (this.isRunning() && !target.isRunning()) ||
          (this.isWaiting() &&
            (target.isRunning() || target.isCancelling() || target.isFailed())))
      );
    }

    isActive(): this is this & { value: RunType.ActiveStatus } {
      return this.isValid() && ActiveStatus.looksLike(this.value);
    }

    isCancelling(): this is this & { value: "cancelling" } {
      return this.isValid() && ActiveStatus.isCancelling(this.value);
    }

    isFailed(): this is this & { value: "failed" } {
      return this.isValid() && TerminalStatus.isFailed(this.value);
    }

    isRunning(): this is this & { value: "running" } {
      return this.isValid() && ActiveStatus.isRunning(this.value);
    }

    isStopped(): this is this & { value: RunType.StoppedStatus } {
      return this.isValid() && StoppedStatus.looksLike(this.value);
    }

    isTerminal(): this is this & { value: RunType.TerminalStatus } {
      return this.isValid() && TerminalStatus.looksLike(this.value);
    }

    isWaiting(): this is this & { value: RunType.WaitingStatus } {
      return this.isValid() && WaitingStatus.looksLike(this.value);
    }
  }

  export class StoppedStatus extends ValueObject<RunType.StoppedStatus> {
    static looksLike(value: unknown): value is RunType.StoppedStatus {
      return RUN_CONSTANT.STOPPED_STATUS.includes(
        value as RunType.StoppedStatus,
      );
    }

    protected validate(value: unknown): value is RunType.StoppedStatus {
      return StoppedStatus.looksLike(value);
    }
  }

  export class TerminalStatus extends ValueObject<RunType.TerminalStatus> {
    static isFailed(value: unknown): value is "failed" {
      return value === "failed";
    }

    static looksLike(value: unknown): value is RunType.TerminalStatus {
      return (
        value === "completed" ||
        TerminalStatus.isFailed(value) ||
        StoppedStatus.looksLike(value)
      );
    }

    protected validate(value: unknown): value is RunType.TerminalStatus {
      return TerminalStatus.looksLike(value);
    }

    isFailed(): this is this & { value: "failed" } {
      return this.isValid() && TerminalStatus.isFailed(this.value);
    }

    isStopped(): this is this & { value: RunType.StoppedStatus } {
      return this.isValid() && StoppedStatus.looksLike(this.value);
    }
  }

  export class WaitingStatus extends ValueObject<RunType.WaitingStatus> {
    static looksLike(value: unknown): value is RunType.WaitingStatus {
      return RUN_CONSTANT.WAITING_STATUS.includes(
        value as RunType.WaitingStatus,
      );
    }

    protected validate(value: unknown): value is RunType.WaitingStatus {
      return WaitingStatus.looksLike(value);
    }
  }
}
