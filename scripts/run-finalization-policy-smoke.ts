import assert from "node:assert/strict";
import { RUN_CONSTANT } from "@/kernel/run/constant";
import { RunType } from "@/kernel/run/type";
import { RunVO } from "@/kernel/run/vo";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TypeContracts = [
  Assert<Equal<RunVO.TerminalStatus["finalizableStatus"], RunType.ActiveStatus[]>>
];

const expected: Record<RunType.TerminalStatus, RunType.ActiveStatus[]> = {
  cancelled: ["running", "waiting_permission", "waiting_children", "cancelling"],
  completed: ["running"],
  failed: ["running"],
  interrupted: ["running", "cancelling"]
};

for (const terminal of RUN_CONSTANT.TERMINAL_STATUS) {
  const value = new RunVO.TerminalStatus(terminal);
  const statuses = value.finalizableStatus;
  assert.deepEqual(statuses, expected[terminal], terminal);
  assert.equal(new Set(statuses).size, statuses.length);
  assert.notStrictEqual(statuses, RUN_CONSTANT.ACTIVE_STATUS);
  assert.notStrictEqual(statuses, value.finalizableStatus);
  for (const source of statuses) {
    const status = new RunVO.Status(source);
    assert.equal(status.isActive(), true);
    assert.equal(status.canTransitionTo(new RunVO.Status(terminal)), true);
  }
  statuses[0] = "cancelling";
  statuses.pop();
  statuses.push("waiting_children");
  assert.deepEqual(value.finalizableStatus, expected[terminal], "caller mutation changed subsequent policy reads");
  assert.deepEqual(new RunVO.TerminalStatus(terminal).finalizableStatus, expected[terminal]);
}

for (const input of [null, undefined, false, 0, {}, [], "", "unknown", " cancelled", "CANCELLED", ...RUN_CONSTANT.ACTIVE_STATUS]) {
  const invalid = new RunVO.TerminalStatus(input);
  assert.equal(invalid.isInvalid(), true);
  assert.throws(() => invalid.finalizableStatus, Error);
}

assert.equal(new RunVO.TerminalStatus("cancelled").finalizableStatus.length, 4);
assert.deepEqual(new RunVO.TerminalStatus("cancelled").finalizableStatus.sort(), [...RUN_CONSTANT.ACTIVE_STATUS].sort());
assert.equal(new RunVO.TerminalStatus("interrupted").finalizableStatus.length, 2);
for (const waiting of ["waiting_children", "waiting_permission"] as const) {
  assert.equal(new RunVO.Status(waiting).canTransitionTo(new RunVO.Status("interrupted")), true);
  assert.equal(new RunVO.TerminalStatus("interrupted").finalizableStatus.includes(waiting), false, "operation admissibility was conflated with generic transitions");
}

console.log("Run finalization policy smoke passed: terminal VO getter, exact source order, fresh arrays, invalid getter errors and distinction from generic transitions.");
