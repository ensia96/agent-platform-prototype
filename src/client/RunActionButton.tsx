import type { PublicRunSummary } from "../shared/types";
import { RunVO } from "@/run/vo";

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
  if (!activeRun || new RunVO.Status(activeRun.status).isTerminal()) {
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
