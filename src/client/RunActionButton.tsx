import type { PublicRunSummary } from "../shared/types";
import { isTerminalRunStatus } from "../shared/types";

export function RunActionButton({
  activeRun,
  cancelPending,
  runDisabled,
  onCancel
}: {
  activeRun: PublicRunSummary | null;
  cancelPending: boolean;
  runDisabled: boolean;
  onCancel: () => void;
}) {
  if (!activeRun || isTerminalRunStatus(activeRun.status)) {
    return (
      <button type="submit" disabled={runDisabled}>
        Run
      </button>
    );
  }

  const cancelling = cancelPending || activeRun.status === "cancelling";
  return (
    <button type="button" onClick={onCancel} disabled={cancelling}>
      {cancelling ? "Cancelling…" : "Cancel"}
    </button>
  );
}
