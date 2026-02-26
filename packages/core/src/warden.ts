/**
 * Traffic Warden — Priority Scheduler
 *
 * Sits between the CLI/API layer and the SessionManager. Intercepts spawn
 * requests, scores them by priority, and controls when they execute based
 * on resource availability and concurrency limits.
 *
 * Architecture:
 *   CLI/Telegram → Warden.enqueue() → priority queue
 *   LifecycleManager → Warden.tick() → spawns next if capacity available
 *   SessionManager → actual spawn/kill
 */

import { randomUUID } from "node:crypto";
import type {
  Warden,
  WardenConfig,
  QueueItem,
  QueueInput,
  QueuePriority,
  ResourceStatus,
} from "./warden-types.js";
import { WARDEN_DEFAULTS } from "./warden-types.js";
import type { ResourceMonitor } from "./resource-monitor.js";
import type { SessionManager } from "./types.js";

/** Numeric value for priority levels (higher = more important). */
const PRIORITY_VALUES: Record<QueuePriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Numeric cost for resource levels (higher = more expensive). */
const RESOURCE_COST_VALUES: Record<string, number> = {
  light: 0.3,
  normal: 0.6,
  heavy: 1.0,
};

export interface WardenDeps {
  config: WardenConfig;
  sessionManager: SessionManager;
  resourceMonitor: ResourceMonitor;
  /** Optional callback when a queued item starts spawning. */
  onSpawn?: (item: QueueItem) => void;
  /** Optional callback when spawning fails. */
  onSpawnError?: (item: QueueItem, error: Error) => void;
}

/** Create a Traffic Warden instance. */
export function createWarden(deps: WardenDeps): Warden {
  const {
    config = WARDEN_DEFAULTS,
    sessionManager,
    resourceMonitor,
    onSpawn,
    onSpawnError,
  } = deps;

  const queue: QueueItem[] = [];
  let paused = false;
  let ticking = false; // re-entrancy guard

  /** Compute a priority score for a queue item. */
  function computeScore(item: QueueInput): number {
    const weights = config.priorityWeights;

    const priorityVal = PRIORITY_VALUES[item.priority ?? "normal"];
    const completionVal = item.completionEstimate ?? 0;
    const costVal = RESOURCE_COST_VALUES[item.resourceCost ?? "normal"] ?? 0.6;

    return (
      priorityVal * weights.manualPriority +
      completionVal * weights.completionCloseness -
      costVal * weights.resourceCost
    );
  }

  /** Sort queue by score descending (highest priority first). */
  function sortQueue(): void {
    queue.sort((a, b) => {
      // Primary: score descending
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreak: earlier enqueue time first (FIFO)
      return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
    });
  }

  /** Get pending items (not yet spawned). */
  function getPending(): QueueItem[] {
    return queue.filter((item) => item.status === "pending");
  }

  /** Get active items (currently running). */
  function getActive(): QueueItem[] {
    return queue.filter((item) => item.status === "active" || item.status === "spawning");
  }

  /** Try to spawn the next pending item if resources allow. */
  async function trySpawnNext(): Promise<void> {
    const pending = getPending();
    if (pending.length === 0) return;

    const activeCount = getActive().length;
    const { allowed, reason } = resourceMonitor.canSpawnMore(config, activeCount);

    if (!allowed) return;

    // Take the highest-priority pending item
    const item = pending[0];
    if (!item) return;

    item.status = "spawning";
    onSpawn?.(item);

    try {
      const session = await sessionManager.spawn({
        projectId: item.projectId,
        issueId: item.issueId,
        branch: item.branch,
        prompt: item.prompt,
        agent: item.agent,
      });

      item.status = "active";
      item.sessionId = session.id;
    } catch (err) {
      // Spawn failed — put back in pending for retry on next tick
      item.status = "pending";
      onSpawnError?.(item, err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    enqueue(input: QueueInput): string {
      const id = randomUUID();
      const item: QueueItem = {
        id,
        projectId: input.projectId,
        issueId: input.issueId,
        priority: input.priority ?? "normal",
        score: computeScore(input),
        enqueuedAt: new Date(),
        status: "pending",
        branch: input.branch,
        prompt: input.prompt,
        agent: input.agent,
        completionEstimate: input.completionEstimate,
        resourceCost: input.resourceCost,
      };

      queue.push(item);
      sortQueue();
      return id;
    },

    async tick(): Promise<void> {
      // Re-entrancy guard
      if (ticking) return;
      if (paused) return;
      ticking = true;

      try {
        // Try to spawn items up to capacity
        // Loop because a single tick might have room for multiple spawns
        let attempts = 0;
        const maxAttempts = config.maxConcurrentSessions - getActive().length;

        while (attempts < maxAttempts && getPending().length > 0) {
          await trySpawnNext();
          attempts++;
        }

        // Clean up completed/cancelled items older than 1 hour
        const oneHourAgo = Date.now() - 3_600_000;
        for (let i = queue.length - 1; i >= 0; i--) {
          const item = queue[i];
          if (
            (item.status === "completed" || item.status === "cancelled") &&
            item.enqueuedAt.getTime() < oneHourAgo
          ) {
            queue.splice(i, 1);
          }
        }
      } finally {
        ticking = false;
      }
    },

    getQueue(): QueueItem[] {
      return [...queue];
    },

    cancel(id: string): boolean {
      const item = queue.find((i) => i.id === id);
      if (!item) return false;
      if (item.status === "active" || item.status === "spawning") return false;
      item.status = "cancelled";
      return true;
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    isPaused(): boolean {
      return paused;
    },

    async getResourceStatus(): Promise<ResourceStatus> {
      return resourceMonitor.getStatus(config);
    },

    markCompleted(sessionId: string): void {
      const item = queue.find(
        (i) => i.sessionId === sessionId && i.status === "active",
      );
      if (item) {
        item.status = "completed";
      }
    },

    markFailed(sessionId: string): void {
      const item = queue.find(
        (i) => i.sessionId === sessionId && (i.status === "active" || i.status === "spawning"),
      );
      if (item) {
        item.status = "completed"; // Mark as done so it doesn't re-queue
      }
    },
  };
}
