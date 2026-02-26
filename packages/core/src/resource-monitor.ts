/**
 * Resource Monitor — lightweight system health checker.
 *
 * Provides real-time system resource stats (CPU, RAM, disk) and determines
 * whether the system has capacity to spawn more agent sessions.
 *
 * Uses Node.js `os` module for local stats. Extensible for remote machines later.
 */

import { cpus, freemem, totalmem, loadavg } from "node:os";
import { execSync } from "node:child_process";
import type { ResourceStatus, WardenConfig } from "./warden-types.js";

/** Get the number of CPU cores. */
function getCpuCount(): number {
  return cpus().length;
}

/**
 * Get CPU load as a 0-1 ratio (1 = all cores fully loaded).
 * Uses 1-minute load average on Linux, normalized by core count.
 */
function getCpuLoad(): number {
  const [load1min] = loadavg();
  const cores = getCpuCount();
  // Normalize: loadavg of 8 on 8 cores = 1.0
  return Math.min(load1min / cores, 1.0);
}

/** Get free RAM in MB. */
function getFreeRamMB(): number {
  return Math.round(freemem() / (1024 * 1024));
}

/** Get total RAM in MB. */
function getTotalRamMB(): number {
  return Math.round(totalmem() / (1024 * 1024));
}

/**
 * Get disk free space in GB for the home directory.
 * Falls back to root if home dir check fails.
 */
function getDiskFreeGB(): number {
  try {
    // Use df on Linux/WSL
    const output = execSync("df -BG --output=avail / 2>/dev/null | tail -1", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const match = output.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** Get total disk space in GB. */
function getDiskTotalGB(): number {
  try {
    const output = execSync("df -BG --output=size / 2>/dev/null | tail -1", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const match = output.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** Count active tmux sessions that look like AO sessions. */
function getActiveTmuxSessionCount(): number {
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!output) return 0;
    // Count sessions — all tmux sessions count as active
    return output.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export interface ResourceMonitor {
  /** Get a snapshot of current system resources. */
  getStatus(config: WardenConfig): ResourceStatus;
  /** Check if the system can handle more sessions. */
  canSpawnMore(config: WardenConfig, currentActive: number): { allowed: boolean; reason?: string };
}

/** Create a resource monitor instance. */
export function createResourceMonitor(): ResourceMonitor {
  return {
    getStatus(config: WardenConfig): ResourceStatus {
      const cpuLoad = getCpuLoad();
      const ramFreeMB = getFreeRamMB();
      const ramTotalMB = getTotalRamMB();
      const diskFreeGB = getDiskFreeGB();
      const diskTotalGB = getDiskTotalGB();
      const activeSessions = getActiveTmuxSessionCount();

      const { allowed, reason } = this.canSpawnMore(config, activeSessions);

      return {
        cpuLoad,
        ramFreeMB,
        ramTotalMB,
        diskFreeGB,
        diskTotalGB,
        activeSessions,
        canSpawnMore: allowed,
        reason,
      };
    },

    canSpawnMore(
      config: WardenConfig,
      currentActive: number,
    ): { allowed: boolean; reason?: string } {
      const { resourceThresholds, maxConcurrentSessions } = config;

      // Check concurrency limit
      if (currentActive >= maxConcurrentSessions) {
        return {
          allowed: false,
          reason: `At max concurrent sessions (${currentActive}/${maxConcurrentSessions})`,
        };
      }

      // Check RAM
      const ramFreeMB = getFreeRamMB();
      if (ramFreeMB < resourceThresholds.minFreeRamMB) {
        return {
          allowed: false,
          reason: `Low RAM: ${ramFreeMB}MB free (min: ${resourceThresholds.minFreeRamMB}MB)`,
        };
      }

      // Check CPU
      const cpuLoad = getCpuLoad();
      if (cpuLoad > resourceThresholds.maxCpuLoad) {
        return {
          allowed: false,
          reason: `High CPU: ${(cpuLoad * 100).toFixed(0)}% (max: ${(resourceThresholds.maxCpuLoad * 100).toFixed(0)}%)`,
        };
      }

      // Check disk
      const diskFreeGB = getDiskFreeGB();
      if (diskFreeGB < resourceThresholds.minFreeDiskGB) {
        return {
          allowed: false,
          reason: `Low disk: ${diskFreeGB}GB free (min: ${resourceThresholds.minFreeDiskGB}GB)`,
        };
      }

      return { allowed: true };
    },
  };
}
