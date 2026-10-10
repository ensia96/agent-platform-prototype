export namespace PermissionRequestType {
  export type ResolvedStatus = "approved" | "denied" | "expired";

  export type Status = "pending" | ResolvedStatus;
}
