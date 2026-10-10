import assert from "node:assert/strict";
import { ValueObject } from "@/_/vo";
import { RunType } from "@/run/type";
import { RUN_CONSTANT } from "@/run/constant";
import { RunVO } from "@/run/vo";

const states = ["running", "waiting_permission", "waiting_children", "cancelling", "completed", "cancelled", "failed", "interrupted"] as const;
const waiting = ["waiting_children", "waiting_permission"] as const;
const stopped = ["cancelled", "interrupted"] as const;
const active = ["cancelling", "running", "waiting_children", "waiting_permission"] as const;
const terminal = ["completed", "failed", "cancelled", "interrupted"] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TypeContracts = [
  Assert<Equal<RunType.WaitingStatus, typeof waiting[number]>>,
  Assert<Equal<RunType.StoppedStatus, typeof stopped[number]>>,
  Assert<Equal<RunType.ActiveStatus, "cancelling" | "running" | RunType.WaitingStatus>>,
  Assert<Equal<RunType.TerminalStatus, "completed" | "failed" | RunType.StoppedStatus>>,
  Assert<Equal<RunType.Status, RunType.ActiveStatus | RunType.TerminalStatus>>,
  Assert<Equal<typeof RUN_CONSTANT.WAITING_STATUS, RunType.WaitingStatus[]>>,
  Assert<Equal<typeof RUN_CONSTANT.STOPPED_STATUS, RunType.StoppedStatus[]>>,
  Assert<Equal<ConstructorParameters<typeof RunVO.WaitingStatus>, [props: unknown]>>,
  Assert<Equal<ConstructorParameters<typeof RunVO.StoppedStatus>, [props: unknown]>>,
  Assert<Equal<RunVO.WaitingStatus["value"], RunType.WaitingStatus>>,
  Assert<Equal<RunVO.StoppedStatus["value"], RunType.StoppedStatus>>,
  Assert<Equal<typeof RunVO.WaitingStatus.looksLike, (value: unknown) => value is RunType.WaitingStatus>>,
  Assert<Equal<typeof RunVO.StoppedStatus.looksLike, (value: unknown) => value is RunType.StoppedStatus>>,
  Assert<Equal<RunType.Status, typeof states[number]>>,
  Assert<Equal<RunType.ActiveStatus, typeof active[number]>>,
  Assert<Equal<RunType.TerminalStatus, typeof terminal[number]>>,
  Assert<Equal<typeof RUN_CONSTANT.ACTIVE_STATUS, RunType.ActiveStatus[]>>,
  Assert<Equal<typeof RUN_CONSTANT.TERMINAL_STATUS, RunType.TerminalStatus[]>>,
  Assert<Equal<ConstructorParameters<typeof RunVO.ActiveStatus>, [props: unknown]>>,
  Assert<Equal<ConstructorParameters<typeof RunVO.TerminalStatus>, [props: unknown]>>,
  Assert<Equal<RunVO.ActiveStatus["value"], RunType.ActiveStatus>>,
  Assert<Equal<RunVO.TerminalStatus["value"], RunType.TerminalStatus>>,
  Assert<Equal<typeof RunVO.ActiveStatus.looksLike, (value: unknown) => value is RunType.ActiveStatus>>,
  Assert<Equal<typeof RunVO.TerminalStatus.looksLike, (value: unknown) => value is RunType.TerminalStatus>>,
  Assert<Equal<typeof RunVO.ActiveStatus.isCancelling, (value: unknown) => value is "cancelling">>,
  Assert<Equal<typeof RunVO.ActiveStatus.isRunning, (value: unknown) => value is "running">>,
  Assert<Equal<typeof RunVO.TerminalStatus.isFailed, (value: unknown) => value is "failed">>,
  Assert<Equal<typeof RunVO.Status.looksLike, (value: unknown) => value is RunType.Status>>,
  Assert<Equal<ConstructorParameters<typeof RunVO.Status>, [props: unknown]>>,
  Assert<Equal<RunVO.Status["value"], RunType.Status>>,
  Assert<Equal<RunVO.ActiveStatus["isCancelling"], () => boolean>>,
  Assert<Equal<RunVO.ActiveStatus["isRunning"], () => boolean>>,
  Assert<Equal<RunVO.ActiveStatus["isWaiting"], () => boolean>>,
  Assert<Equal<RunVO.Status["isActive"], () => boolean>>,
  Assert<Equal<RunVO.Status["isCancelling"], () => boolean>>,
  Assert<Equal<RunVO.Status["isFailed"], () => boolean>>,
  Assert<Equal<RunVO.Status["isRunning"], () => boolean>>,
  Assert<Equal<RunVO.Status["isStopped"], () => boolean>>,
  Assert<Equal<RunVO.Status["isWaiting"], () => boolean>>,
  Assert<Equal<RunVO.TerminalStatus["isFailed"], () => boolean>>,
  Assert<Equal<RunVO.TerminalStatus["isStopped"], () => boolean>>,
  Assert<Equal<ReturnType<RunVO.Status["isTerminal"]>, boolean>>,
  Assert<Equal<RunVO.Status["canTransitionTo"], (target: RunVO.Status) => boolean>>
];

// Columns follow states above; this table is independent of the implementation.
const expected: Record<RunType.Status, readonly number[]> = {
  running:            [0, 1, 1, 1, 1, 1, 1, 1],
  waiting_permission: [1, 0, 0, 1, 0, 1, 1, 1],
  waiting_children:   [1, 0, 0, 1, 0, 1, 1, 1],
  cancelling:         [0, 0, 0, 0, 0, 1, 0, 1],
  completed:          [0, 0, 0, 0, 0, 0, 0, 0],
  cancelled:          [0, 0, 0, 0, 0, 0, 0, 0],
  failed:             [0, 0, 0, 0, 0, 0, 0, 0],
  interrupted:        [0, 0, 0, 0, 0, 0, 0, 0]
};

assert.equal(states.length, 8);
assert.equal(active.length, 4);
assert.equal(terminal.length, 4);
assert.deepEqual(RUN_CONSTANT.WAITING_STATUS, waiting);
assert.deepEqual(RUN_CONSTANT.STOPPED_STATUS, stopped);
assert.deepEqual(RUN_CONSTANT.ACTIVE_STATUS, active);
assert.deepEqual(RUN_CONSTANT.TERMINAL_STATUS, terminal);
assert.deepEqual(RUN_CONSTANT.ACTIVE_STATUS, ["cancelling", "running", ...RUN_CONSTANT.WAITING_STATUS]);
assert.deepEqual(RUN_CONSTANT.TERMINAL_STATUS, ["completed", "failed", ...RUN_CONSTANT.STOPPED_STATUS]);
assert.deepEqual([...RUN_CONSTANT.ACTIVE_STATUS, ...RUN_CONSTANT.TERMINAL_STATUS].sort(), [...states].sort());
assert.equal(new Set([...RUN_CONSTANT.ACTIVE_STATUS, ...RUN_CONSTANT.TERMINAL_STATUS]).size, 8);
assert.deepEqual(Object.keys(RUN_CONSTANT).sort(), ["ACTIVE_STATUS", "STOPPED_STATUS", "TERMINAL_STATUS", "WAITING_STATUS"]);

const invalidInputs: unknown[] = [null, undefined, 0, NaN, true, {}, [], Object.create(null), new String("running"), "", "unknown", "queued", "starting", " running", "RUNNING", Symbol("running"), 1n];
for (const { VO, allowed } of [
  { VO: RunVO.WaitingStatus, allowed: waiting },
  { VO: RunVO.StoppedStatus, allowed: stopped },
  { VO: RunVO.ActiveStatus, allowed: active },
  { VO: RunVO.TerminalStatus, allowed: terminal }
]) {
  for (const input of [...states, ...invalidInputs]) {
    const valid = allowed.some((state) => state === input);
    const value = new VO(input);
    assert.equal(VO.looksLike(input), valid);
    assert.equal(value.isValid(), valid);
    assert.equal(value.isInvalid(), !valid);
    assert.ok(value instanceof ValueObject);
    assert.equal(Object.isFrozen(value), true);
    if (valid) {
      assert.equal(value.value, input);
      assert.equal(value.props, input);
    } else {
      assert.throws(() => value.value, Error);
      assert.throws(() => value.props, Error);
    }
  }
}

for (const input of [...states, ...invalidInputs]) {
  assert.equal(RunVO.ActiveStatus.isCancelling(input), input === "cancelling");
  assert.equal(RunVO.ActiveStatus.isRunning(input), input === "running");
  assert.equal(RunVO.TerminalStatus.isFailed(input), input === "failed");
  if (RunVO.WaitingStatus.looksLike(input)) {
    const narrowed: RunType.WaitingStatus = input;
    assert.ok(RUN_CONSTANT.WAITING_STATUS.includes(narrowed));
  }
  if (RunVO.StoppedStatus.looksLike(input)) {
    const narrowed: RunType.StoppedStatus = input;
    assert.ok(RUN_CONSTANT.STOPPED_STATUS.includes(narrowed));
  }
  const activeValue = new RunVO.ActiveStatus(input);
  assert.equal(activeValue.isCancelling(), input === "cancelling");
  assert.equal(activeValue.isRunning(), input === "running");
  if (activeValue.isCancelling()) {
    assert.equal(activeValue.value, input);
  }
  if (activeValue.isRunning()) {
    assert.equal(activeValue.value, input);
  }
  assert.equal(activeValue.isWaiting(), waiting.some((state) => state === input));
  if (activeValue.isWaiting()) {
    assert.ok(RUN_CONSTANT.WAITING_STATUS.some((state) => state === activeValue.value));
  }
  const terminalValue = new RunVO.TerminalStatus(input);
  assert.equal(terminalValue.isFailed(), input === "failed");
  if (terminalValue.isFailed()) {
    assert.equal(terminalValue.value, input);
  }
  assert.equal(terminalValue.isStopped(), stopped.some((state) => state === input));
  if (terminalValue.isStopped()) {
    assert.ok(RUN_CONSTANT.STOPPED_STATUS.some((state) => state === terminalValue.value));
  }
  if (RunVO.ActiveStatus.looksLike(input)) {
    const narrowed: RunType.ActiveStatus = input;
    assert.ok(RUN_CONSTANT.ACTIVE_STATUS.includes(narrowed));
  }
  if (RunVO.TerminalStatus.looksLike(input)) {
    const narrowed: RunType.TerminalStatus = input;
    assert.ok(RUN_CONSTANT.TERMINAL_STATUS.includes(narrowed));
  }
  if (RunVO.Status.looksLike(input)) {
    const narrowed: RunType.Status = input;
    assert.ok(states.includes(narrowed));
  }
  assert.equal(RunVO.Status.looksLike(input), RunVO.ActiveStatus.looksLike(input) || RunVO.TerminalStatus.looksLike(input));
  assert.equal(RunVO.ActiveStatus.looksLike(input), input === "cancelling" || input === "running" || RunVO.WaitingStatus.looksLike(input));
  assert.equal(RunVO.TerminalStatus.looksLike(input), input === "completed" || input === "failed" || RunVO.StoppedStatus.looksLike(input));
}

for (const from of states) {
  const value = new RunVO.Status(from);
  assert.equal(RunVO.Status.looksLike(from), true);
  assert.ok(value instanceof ValueObject);
  assert.equal(value.isValid(), true);
  assert.equal(value.isInvalid(), false);
  assert.equal(value.value, from);
  assert.equal(value.props, from);
  assert.equal(JSON.stringify(value.value), JSON.stringify(from));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.isActive(), (active as readonly string[]).includes(from));
  assert.equal(value.isTerminal(), (terminal as readonly string[]).includes(from));
  assert.equal(value.isActive(), RunVO.ActiveStatus.looksLike(from));
  assert.equal(value.isTerminal(), RunVO.TerminalStatus.looksLike(from));
  assert.equal(value.isWaiting(), RunVO.WaitingStatus.looksLike(from));
  assert.equal(value.isStopped(), RunVO.StoppedStatus.looksLike(from));
  assert.equal(value.isCancelling(), from === "cancelling");
  assert.equal(value.isFailed(), from === "failed");
  assert.equal(value.isRunning(), from === "running");
  if (value.isCancelling()) {
    assert.equal(value.value, from);
  }
  if (value.isFailed()) {
    assert.equal(value.value, from);
  }
  if (value.isRunning()) {
    assert.equal(value.value, from);
  }
  assert.equal(value instanceof RunVO.ActiveStatus, false);
  assert.equal(value instanceof RunVO.TerminalStatus, false);
  assert.notEqual(value.isActive(), value.isTerminal());
  assert.equal(expected[from].length, states.length);
  for (const [column, to] of states.entries()) {
    assert.equal(value.canTransitionTo(new RunVO.Status(to)), expected[from][column] === 1, `VO ${from} → ${to}`);
  }
  if (value.isActive()) {
    assert.ok(RUN_CONSTANT.ACTIVE_STATUS.some((state) => state === value.value));
    assert.equal(value.canTransitionTo(new RunVO.Status("running")), expected[from][0] === 1);
  }
  if (value.isTerminal()) {
    const narrowed: RunType.TerminalStatus = value.value;
    assert.ok(RUN_CONSTANT.TERMINAL_STATUS.includes(narrowed));
    assert.equal(value.canTransitionTo(new RunVO.Status("running")), false);
  }
  if (value.isWaiting()) {
    assert.ok(RUN_CONSTANT.WAITING_STATUS.some((state) => state === value.value));
    assert.equal(value.canTransitionTo(new RunVO.Status("running")), true);
  }
  if (value.isStopped()) {
    assert.ok(RUN_CONSTANT.STOPPED_STATUS.some((state) => state === value.value));
    assert.equal(value.canTransitionTo(new RunVO.Status("running")), false);
  }
}

for (const input of invalidInputs) {
  const invalid = new RunVO.Status(input);
  assert.equal(RunVO.Status.looksLike(input), false);
  assert.equal(invalid.isValid(), false);
  assert.equal(invalid.isInvalid(), true);
  assert.equal(Object.isFrozen(invalid), true);
  assert.throws(() => invalid.value, Error);
  assert.throws(() => invalid.props, Error);
  assert.equal(invalid.isActive(), false);
  assert.equal(invalid.isTerminal(), false);
  assert.equal(invalid.isWaiting(), false);
  assert.equal(invalid.isStopped(), false);
  assert.equal(invalid.isCancelling(), false);
  assert.equal(invalid.isFailed(), false);
  assert.equal(invalid.isRunning(), false);
  assert.equal(invalid.canTransitionTo(invalid), false);
  for (const state of states) {
    const valid = new RunVO.Status(state);
    assert.equal(valid.canTransitionTo(invalid), false);
    assert.equal(invalid.canTransitionTo(valid), false);
  }
}
console.log("Run status smoke passed: subgroup and named predicates, bottom-up composition, 64 transitions, invalid Status cases, inferred booleans and required terminal value narrowing.");
