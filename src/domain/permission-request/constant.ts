import { PermissionRequestType } from "@/permission-request/type";

export namespace PERMISSION_REQUEST_CONSTANT {
  export const RESOLVED_STATUS: PermissionRequestType.ResolvedStatus[] = [
    "approved",
    "denied",
    "expired",
  ];

  export const STATUS: PermissionRequestType.Status[] = [
    "pending",
    ...RESOLVED_STATUS,
  ];
}
