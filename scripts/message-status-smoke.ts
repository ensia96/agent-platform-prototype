import assert from "node:assert/strict";
import { ValueObject } from "@/_/vo";
import { MESSAGE_CONSTANT } from "@/message/constant";
import { MessageType } from "@/message/type";
import { MessageVO } from "@/message/vo";

const states = ["completed", "streaming", "cancelled", "failed", "interrupted"] as const;
const stopped = ["cancelled", "interrupted"] as const;
const terminal = ["completed", "failed", "cancelled", "interrupted"] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TypeContracts = [
  Assert<Equal<MessageType.Status, typeof states[number]>>,
  Assert<Equal<MessageType.StoppedStatus, typeof stopped[number]>>,
  Assert<Equal<MessageType.TerminalStatus, typeof terminal[number]>>,
  Assert<Equal<MessageType.Status, "streaming" | MessageType.TerminalStatus>>,
  Assert<Equal<MessageType.TerminalStatus, "completed" | "failed" | MessageType.StoppedStatus>>,
  Assert<Equal<typeof MESSAGE_CONSTANT.STOPPED_STATUS, MessageType.StoppedStatus[]>>,
  Assert<Equal<typeof MESSAGE_CONSTANT.TERMINAL_STATUS, MessageType.TerminalStatus[]>>,
  Assert<Equal<ConstructorParameters<typeof MessageVO.Status>, [props: unknown]>>,
  Assert<Equal<ConstructorParameters<typeof MessageVO.StoppedStatus>, [props: unknown]>>,
  Assert<Equal<ConstructorParameters<typeof MessageVO.TerminalStatus>, [props: unknown]>>,
  Assert<Equal<MessageVO.Status["value"], MessageType.Status>>,
  Assert<Equal<MessageVO.StoppedStatus["value"], MessageType.StoppedStatus>>,
  Assert<Equal<MessageVO.TerminalStatus["value"], MessageType.TerminalStatus>>,
  Assert<Equal<typeof MessageVO.Status.looksLike, (value: unknown) => value is MessageType.Status>>,
  Assert<Equal<typeof MessageVO.StoppedStatus.looksLike, (value: unknown) => value is MessageType.StoppedStatus>>,
  Assert<Equal<typeof MessageVO.TerminalStatus.looksLike, (value: unknown) => value is MessageType.TerminalStatus>>
];

const expected: Record<MessageType.Status, [completed: boolean, failed: boolean, stopped: boolean, streaming: boolean, terminal: boolean]> = {
  completed:   [true,  false, false, false, true],
  streaming:   [false, false, false, true,  false],
  cancelled:   [false, false, true,  false, true],
  failed:      [false, true,  false, false, true],
  interrupted: [false, false, true,  false, true]
};

assert.deepEqual(MESSAGE_CONSTANT.STOPPED_STATUS, stopped);
assert.deepEqual(MESSAGE_CONSTANT.TERMINAL_STATUS, terminal);
assert.deepEqual(MESSAGE_CONSTANT.TERMINAL_STATUS, ["completed", "failed", ...MESSAGE_CONSTANT.STOPPED_STATUS]);
assert.deepEqual(["streaming", ...MESSAGE_CONSTANT.TERMINAL_STATUS].sort(), [...states].sort());
assert.equal(new Set(["streaming", ...MESSAGE_CONSTANT.TERMINAL_STATUS]).size, 5);
assert.deepEqual(Object.keys(MESSAGE_CONSTANT).sort(), ["STOPPED_STATUS", "TERMINAL_STATUS"]);

const invalidInputs: unknown[] = [null, undefined, 0, NaN, true, {}, [], Object.create(null), new String("completed"), "", "unknown", " completed", "completed ", "COMPLETED", "running", "cancelling", "waiting_children", "waiting_permission", Symbol("completed"), 1n];
for (const { VO, allowed } of [
  { VO: MessageVO.StoppedStatus, allowed: stopped },
  { VO: MessageVO.TerminalStatus, allowed: terminal },
  { VO: MessageVO.Status, allowed: states }
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
  const value = new MessageVO.Status(input);
  const terminalValue = new MessageVO.TerminalStatus(input);
  const row = MessageVO.Status.looksLike(input) ? expected[input] : [false, false, false, false, false];
  assert.deepEqual([value.isCompleted(), value.isFailed(), value.isStopped(), value.isStreaming(), value.isTerminal()], row);
  assert.deepEqual([terminalValue.isCompleted(), terminalValue.isFailed(), terminalValue.isStopped()], row.slice(0, 3));
  assert.equal(MessageVO.Status.isStreaming(input), row[3]);
  assert.equal(MessageVO.TerminalStatus.isCompleted(input), row[0]);
  assert.equal(MessageVO.TerminalStatus.isFailed(input), row[1]);
  assert.equal(MessageVO.TerminalStatus.looksLike(input), MessageVO.TerminalStatus.isCompleted(input) || MessageVO.TerminalStatus.isFailed(input) || MessageVO.StoppedStatus.looksLike(input));
  assert.equal(MessageVO.Status.looksLike(input), MessageVO.Status.isStreaming(input) || MessageVO.TerminalStatus.looksLike(input));
  assert.equal("canTransitionTo" in value, false);
  if (value.isCompleted()) {
    const narrowed: "completed" = value.value;
    assert.equal(narrowed, input);
  }
  if (value.isFailed()) {
    const narrowed: "failed" = value.value;
    assert.equal(narrowed, input);
  }
  if (value.isStopped()) {
    const narrowed: MessageType.StoppedStatus = value.value;
    assert.ok(MESSAGE_CONSTANT.STOPPED_STATUS.includes(narrowed));
  }
  if (value.isStreaming()) {
    const narrowed: "streaming" = value.value;
    assert.equal(narrowed, input);
  }
  if (value.isTerminal()) {
    const narrowed: MessageType.TerminalStatus = value.value;
    assert.ok(MESSAGE_CONSTANT.TERMINAL_STATUS.includes(narrowed));
  }
}

console.log("Message status smoke passed: five unchanged values, terminal/stopped composition, invalid VO handling, classifications and value narrowing; no transition policy.");
