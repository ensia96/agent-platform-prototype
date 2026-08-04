import { randomUUID } from "node:crypto";
import type { DaemonLeaseRecord, StoreAdapter } from "../store/types";

export const defaultDatabaseLeaseTtlMs = 15_000;
export const defaultDatabaseLeaseHeartbeatMs = 5_000;

type LeaseStore = Pick<
  StoreAdapter,
  "getDaemonLease" | "createDaemonLease" | "takeOverDaemonLease" | "heartbeatDaemonLease" | "releaseDaemonLease"
>;

export interface DatabaseLeaseOptions {
  store: LeaseStore;
  ownerId?: string;
  pid?: number;
  ttlMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export type DatabaseLeaseAcquireResult =
  | { acquired: true; tookOverStaleLease: boolean; lease: DaemonLeaseRecord }
  | { acquired: false; lease: DaemonLeaseRecord | null; reason: "live_owner" | "contended" };

export class DatabaseLease {
  readonly ownerId: string;
  readonly pid: number;

  private readonly store: LeaseStore;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private acquired = false;

  constructor(options: DatabaseLeaseOptions) {
    this.store = options.store;
    this.ownerId = options.ownerId?.trim() || randomUUID();
    this.pid = positivePid(options.pid ?? process.pid);
    this.ttlMs = positiveDuration(options.ttlMs, defaultDatabaseLeaseTtlMs, "ttlMs");
    this.heartbeatMs = positiveDuration(options.heartbeatMs, defaultDatabaseLeaseHeartbeatMs, "heartbeatMs");
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? isLocalProcessAlive;
  }

  acquire(): DatabaseLeaseAcquireResult {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = this.now();
      const candidate = this.leaseRecord(now);
      if (this.store.createDaemonLease(candidate)) {
        this.acquired = true;
        return { acquired: true, tookOverStaleLease: false, lease: candidate };
      }

      const current = this.store.getDaemonLease();
      if (!current) {
        continue;
      }
      if (current.ownerId === this.ownerId && current.pid === this.pid) {
        this.acquired = this.store.heartbeatDaemonLease(this.ownerId, this.pid, candidate.heartbeatAt);
        if (this.acquired) {
          return { acquired: true, tookOverStaleLease: false, lease: { ...current, heartbeatAt: candidate.heartbeatAt } };
        }
        continue;
      }

      const heartbeatAtMs = Date.parse(current.heartbeatAt);
      const staleHeartbeat = !Number.isFinite(heartbeatAtMs) || now - heartbeatAtMs > this.ttlMs;
      if (!staleHeartbeat || this.isProcessAlive(current.pid)) {
        return { acquired: false, lease: current, reason: "live_owner" };
      }
      if (this.store.takeOverDaemonLease(current.ownerId, current.heartbeatAt, candidate)) {
        this.acquired = true;
        return { acquired: true, tookOverStaleLease: true, lease: candidate };
      }
    }

    return {
      acquired: false,
      lease: this.store.getDaemonLease(),
      reason: "contended"
    };
  }

  startHeartbeat(onLeaseLost: (error?: Error) => void): void {
    if (!this.acquired) {
      throw new Error("Cannot start database lease heartbeat before acquiring the lease.");
    }
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.heartbeat()) {
          return;
        }
        this.stopHeartbeat();
        onLeaseLost(new Error("Database lease ownership was lost."));
      } catch (error) {
        this.stopHeartbeat();
        onLeaseLost(error instanceof Error ? error : new Error(String(error)));
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  heartbeat(): boolean {
    if (!this.acquired) {
      return false;
    }
    const renewed = this.store.heartbeatDaemonLease(this.ownerId, this.pid, new Date(this.now()).toISOString());
    if (!renewed) {
      this.acquired = false;
    }
    return renewed;
  }

  release(): boolean {
    this.stopHeartbeat();
    if (!this.acquired) {
      return false;
    }
    const released = this.store.releaseDaemonLease(this.ownerId);
    this.acquired = false;
    return released;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private leaseRecord(now: number): DaemonLeaseRecord {
    const timestamp = new Date(now).toISOString();
    return {
      ownerId: this.ownerId,
      pid: this.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp
    };
  }
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Database lease ${name} must be a positive finite number.`);
  }
  return duration;
}

function positivePid(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Database lease pid must be a positive integer.");
  }
  return value;
}

function isLocalProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
