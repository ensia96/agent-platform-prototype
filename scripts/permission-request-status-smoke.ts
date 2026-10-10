import assert from "node:assert/strict";
import { ValueObject } from "@/_/vo";
import { PERMISSION_REQUEST_CONSTANT } from "@/permission-request/constant";
import { PermissionRequestType } from "@/permission-request/type";
import { PermissionRequestVO } from "@/permission-request/vo";

const states = ["pending", "approved", "denied", "expired"] as const;
const resolved = ["approved", "denied", "expired"] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TypeContracts = [
  Assert<Equal<PermissionRequestType.Status, typeof states[number]>>,
  Assert<Equal<PermissionRequestType.ResolvedStatus, typeof resolved[number]>>,
  Assert<Equal<PermissionRequestType.Status, "pending" | PermissionRequestType.ResolvedStatus>>,
  Assert<Equal<PermissionRequestType.ResolvedStatus, Exclude<PermissionRequestType.Status, "pending">>>,
  Assert<Equal<typeof PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS, PermissionRequestType.ResolvedStatus[]>>,
  Assert<Equal<ConstructorParameters<typeof PermissionRequestVO.Status>, [props: unknown]>>,
  Assert<Equal<ConstructorParameters<typeof PermissionRequestVO.ResolvedStatus>, [props: unknown]>>,
  Assert<Equal<PermissionRequestVO.Status["value"], PermissionRequestType.Status>>,
  Assert<Equal<PermissionRequestVO.ResolvedStatus["value"], PermissionRequestType.ResolvedStatus>>,
  Assert<Equal<typeof PermissionRequestVO.Status.looksLike, (value: unknown) => value is PermissionRequestType.Status>>,
  Assert<Equal<typeof PermissionRequestVO.ResolvedStatus.looksLike, (value: unknown) => value is PermissionRequestType.ResolvedStatus>>,
  Assert<Equal<typeof PermissionRequestVO.ResolvedStatus.isApproved, (value: unknown) => value is "approved">>,
  Assert<Equal<typeof PermissionRequestVO.Status.isPending, (value: unknown) => value is "pending">>,
  Assert<Equal<PermissionRequestVO.ResolvedStatus["isApproved"], () => boolean>>,
  Assert<Equal<PermissionRequestVO.Status["isApproved"], () => boolean>>,
  Assert<Equal<PermissionRequestVO.Status["isPending"], () => boolean>>,
  Assert<Equal<PermissionRequestVO.Status["isResolved"], () => boolean>>
];

const expected: Record<PermissionRequestType.Status, [approved: boolean, pending: boolean, resolved: boolean]> = {
  pending:  [false, true,  false],
  approved: [true,  false, true],
  denied:   [false, false, true],
  expired:  [false, false, true]
};

assert.deepEqual(PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS, resolved);
assert.deepEqual(PERMISSION_REQUEST_CONSTANT.STATUS, states);
assert.deepEqual(PERMISSION_REQUEST_CONSTANT.STATUS, ["pending", ...PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS]);
assert.deepEqual(["pending", ...PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS], states);
assert.equal(new Set(["pending", ...PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS]).size, 4);
assert.deepEqual(Object.keys(PERMISSION_REQUEST_CONSTANT), ["RESOLVED_STATUS", "STATUS"]);

const invalidInputs: unknown[] = [null, undefined, false, 0, NaN, {}, [], Object.create(null), new String("pending"), "", "unknown", " pending", "pending ", "PENDING", "allow", "ask", "deny", "allowed", "running", "completed", Symbol("pending"), 1n];
for (const { VO, allowed } of [
  { VO: PermissionRequestVO.ResolvedStatus, allowed: resolved },
  { VO: PermissionRequestVO.Status, allowed: states }
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
  const value = new PermissionRequestVO.Status(input);
  const resolvedValue = new PermissionRequestVO.ResolvedStatus(input);
  const row = PermissionRequestVO.Status.looksLike(input) ? expected[input] : [false, false, false];
  assert.deepEqual([value.isApproved(), value.isPending(), value.isResolved()], row);
  assert.equal(resolvedValue.isApproved(), row[0]);
  assert.equal(PermissionRequestVO.ResolvedStatus.isApproved(input), row[0]);
  assert.equal(PermissionRequestVO.Status.isPending(input), row[1]);
  assert.equal(PermissionRequestVO.ResolvedStatus.looksLike(input), row[2]);
  assert.equal(PermissionRequestVO.Status.looksLike(input), PermissionRequestVO.Status.isPending(input) || PermissionRequestVO.ResolvedStatus.looksLike(input));
  assert.equal("canTransitionTo" in value, false);
  if (value.isApproved()) {
    assert.equal(value.value, input);
  }
  if (value.isPending()) {
    assert.equal(value.value, input);
  }
  if (value.isResolved()) {
    assert.ok(PERMISSION_REQUEST_CONSTANT.RESOLVED_STATUS.some((state) => state === value.value));
  }
  if (resolvedValue.isApproved()) {
    assert.equal(resolvedValue.value, input);
  }
}

console.log("Permission request status smoke passed: four unchanged values, resolved composition, invalid VO handling, approved/pending/resolved classifications, inferred booleans and static predicates; no transition policy.");
