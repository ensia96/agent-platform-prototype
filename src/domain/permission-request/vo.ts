import { ValueObject } from "@/_/vo";
import { PERMISSION_REQUEST_CONSTANT } from "@/permission-request/constant";
import { PermissionRequestType } from "@/permission-request/type";

export namespace PermissionRequestVO {
  export class ResolvedStatus extends ValueObject<PermissionRequestType.ResolvedStatus> {
    static isApproved(value: unknown): value is "approved" {
      return value === "approved";
    }

    static looksLike(
      value: unknown,
    ): value is PermissionRequestType.ResolvedStatus {
      return PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS.includes(
        value as PermissionRequestType.ResolvedStatus,
      );
    }

    protected validate(
      value: unknown,
    ): value is PermissionRequestType.ResolvedStatus {
      return ResolvedStatus.looksLike(value);
    }

    isApproved(): this is this & { value: "approved" } {
      return this.isValid() && ResolvedStatus.isApproved(this.value);
    }
  }

  export class Status extends ValueObject<PermissionRequestType.Status> {
    static isPending(value: unknown): value is "pending" {
      return value === "pending";
    }

    static looksLike(value: unknown): value is PermissionRequestType.Status {
      return Status.isPending(value) || ResolvedStatus.looksLike(value);
    }

    protected validate(value: unknown): value is PermissionRequestType.Status {
      return Status.looksLike(value);
    }

    isApproved(): this is this & { value: "approved" } {
      return this.isValid() && ResolvedStatus.isApproved(this.value);
    }

    isPending(): this is this & { value: "pending" } {
      return this.isValid() && Status.isPending(this.value);
    }

    isResolved(): this is this & {
      value: PermissionRequestType.ResolvedStatus;
    } {
      return this.isValid() && ResolvedStatus.looksLike(this.value);
    }
  }
}
