/**
 * Traffic Warden — Type Definitions
 *
 * The Warden is a priority scheduler that sits between the CLI/API layer
 * and the SessionManager. It intercepts spawn requests, scores them by
 * priority, and controls when they execute based on resource availability.
 */

// =============================================================================
// QUEUE
// =============================================================================

/** Priority levels for queue items */
export type QueuePriority = "urgent" | "high" | "normal" | "low";

/** Status of a queue item */
export type QueueItemStatus =
  | "pending"    // waiting in queue
  | "spawning"   // being spawned right now
  | "active"     // session is running
  | "completed"  // session finished successfully
  | "cancelled"; // removed from queue

/** A single item in the priority queue */
export interface QueueItem {
  /** Unique queue item ID */
  id: string;
  /** Project config key (e.g. "beacon") */
  projectId: string;
  /** Issue identifier (e.g. "#42", "INT-1234") */
  issueId?: string;
  /** Manual priority level */
  priority: QueuePriority;
  /** Computed priority score (higher = spawn sooner) */
  score: number;
  /** When this item was added to the queue */
  enqueuedAt: Date;
  /** Current status */
  status: QueueItemStatus;
  /** Git branch override */
  branch?: string;
  /** Custom prompt override */
  prompt?: string;
  /** Agent plugin override */
  agent?: string;
  /** Session ID once spawned */
  sessionId?: string;
  /** Estimated completion percentage (0-1), used for scoring */
  completionEstimate?: number;
  /** Estimated resource cost: "light" | "normal" | "heavy" */
  resourceCost?: "light" | "normal" | "heavy";
}

/** Input for enqueuing a new item (id and score computed automatically) */
export interface QueueInput {
  projectId: string;
  issueId?: string;
  priority?: QueuePriority;
  branch?: string;
  prompt?: string;
  agent?: string;
  completionEstimate?: number;
  resourceCost?: "light" | "normal" | "heavy";
}

// =============================================================================
// RESOURCES
// =============================================================================

/** System resource snapshot */
export interface ResourceStatus {
  /** CPU load average (0-1 scale, 1 = all cores fully loaded) */
  cpuLoad: number;
  /** Free RAM in MB */
  ramFreeMB: number;
  /** Total RAM in MB */
  ramTotalMB: number;
  /** Free disk in GB */
  diskFreeGB: number;
  /** Total disk in GB */
  diskTotalGB: number;
  /** Number of currently active sessions */
  activeSessions: number;
  /** Whether the system can handle more sessions */
  canSpawnMore: boolean;
  /** Human-readable reason if canSpawnMore is false */
  reason?: string;
}

// =============================================================================
// CONFIG
// =============================================================================

/** Warden configuration (lives in agent-orchestrator.yaml under `warden:`) */
export interface WardenConfig {
  /** Maximum concurrent sessions (default: 3 for Aria) */
  maxConcurrentSessions: number;
  /** Resource thresholds — if exceeded, spawning is paused */
  resourceThresholds: {
    /** Minimum free RAM in MB before pausing spawns (default: 2048) */
    minFreeRamMB: number;
    /** Maximum CPU load (0-1) before pausing spawns (default: 0.85) */
    maxCpuLoad: number;
    /** Minimum free disk in GB before pausing spawns (default: 10) */
    minFreeDiskGB: number;
  };
  /** Weights for priority scoring formula */
  priorityWeights: {
    /** Weight for manual priority level (default: 3.0) */
    manualPriority: number;
    /** Weight for completion closeness (default: 1.5) */
    completionCloseness: number;
    /** Weight for resource cost penalty (default: 1.0) */
    resourceCost: number;
  };
  /** How often the warden tick runs in ms (default: 30000) */
  tickIntervalMs: number;
  /** Auto-discover open issues from tracker and enqueue them */
  autoDiscover?: {
    /** Whether auto-discovery is enabled (default: true when warden is configured) */
    enabled: boolean;
    /** Issue labels to filter by (empty = all open issues) */
    labels?: string[];
    /** Max issues to fetch per project per tick (default: 20) */
    maxPerProject?: number;
  };
}

// =============================================================================
// WARDEN INTERFACE
// =============================================================================

/** The Traffic Warden scheduler */
export interface Warden {
  /** Add a work item to the priority queue. Returns the queue item ID. */
  enqueue(input: QueueInput): string;
  /** Run one scheduling cycle: check resources, spawn next if capacity allows. */
  tick(): Promise<void>;
  /** Get all items currently in the queue (including active). */
  getQueue(): QueueItem[];
  /** Cancel/remove an item from the queue. Returns true if found and cancelled. */
  cancel(id: string): boolean;
  /** Pause scheduling (items stay in queue but nothing spawns). */
  pause(): void;
  /** Resume scheduling. */
  resume(): void;
  /** Whether the warden is currently paused. */
  isPaused(): boolean;
  /** Get current resource status. */
  getResourceStatus(): Promise<ResourceStatus>;
  /** Mark a session as completed (called by lifecycle manager). */
  markCompleted(sessionId: string): void;
  /** Mark a session as failed/killed (called by lifecycle manager). */
  markFailed(sessionId: string): void;
  /** Auto-discover open issues and enqueue them. Called by lifecycle tick. */
  discoverAndEnqueue(projects: DiscoverProject[]): Promise<number>;
}

/** Input for auto-discovery — project + its tracker */
export interface DiscoverProject {
  projectId: string;
  listIssues: (filters: { state: string; labels?: string[]; limit?: number }) => Promise<Array<{ id: string; title: string; labels: string[]; priority?: number }>>;
  activeIssueIds: Set<string>;
}

/** Default warden config values */
export const WARDEN_DEFAULTS: WardenConfig = {
  maxConcurrentSessions: 3,
  resourceThresholds: {
    minFreeRamMB: 2048,
    maxCpuLoad: 0.85,
    minFreeDiskGB: 10,
  },
  priorityWeights: {
    manualPriority: 3.0,
    completionCloseness: 1.5,
    resourceCost: 1.0,
  },
  tickIntervalMs: 30_000,
  autoDiscover: {
    enabled: true,
    maxPerProject: 20,
  },
};
