/**
 * Telegram Command Handler — Traffic Warden Bot
 *
 * Polls Telegram getUpdates API for incoming commands and dispatches them
 * to the Warden scheduler, SessionManager, and other core services.
 *
 * Only responds to messages from the configured chatId (Francesco).
 */

import type {
  SessionManager,
  OrchestratorConfig,
} from "./types.js";
import type {
  Warden,
  ResourceStatus,
  QueueItem,
} from "./warden-types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TelegramHandlerDeps {
  botToken: string;
  chatId: string;
  warden: Warden | null;
  sessionManager: SessionManager;
  config: OrchestratorConfig;
}

export interface TelegramHandler {
  start(): void;
  stop(): void;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: "🔴",
  high: "🟡",
  normal: "⚪",
  low: "🔵",
};

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  spawning: "🚀",
  active: "🔄",
  completed: "✅",
  cancelled: "❌",
};

function formatBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
}

function formatResourceStatus(res: ResourceStatus): string {
  const cpuPct = Math.round(res.cpuLoad * 100);
  const lines = [
    `📊 *Resources*`,
    `CPU: ${cpuPct}% | RAM: ${formatBytes(res.ramFreeMB)} free | Disk: ${res.diskFreeGB}GB`,
    `Sessions: ${res.activeSessions}/${res.canSpawnMore ? "can spawn more" : "at capacity"}`,
  ];
  if (res.reason) {
    lines.push(`⚠️ ${res.reason}`);
  }
  return lines.join("\n");
}

function formatQueueItem(item: QueueItem, index: number): string {
  const pEmoji = PRIORITY_EMOJI[item.priority] || "⚪";
  const sEmoji = STATUS_EMOJI[item.status] || "❓";
  const issue = item.issueId ? ` ${item.issueId}` : "";
  return `${index + 1}. ${pEmoji} ${item.priority} ${item.projectId}${issue} ${sEmoji} (${item.status})`;
}

function formatQueue(items: QueueItem[]): string {
  if (items.length === 0) {
    return "📋 *Queue*\nEmpty — nothing queued.";
  }
  const lines = ["📋 *Queue*"];
  for (let i = 0; i < items.length; i++) {
    lines.push(formatQueueItem(items[i], i));
  }
  return lines.join("\n");
}

// ─── Command Handlers ────────────────────────────────────────────────────────

type CommandFn = (args: string[], deps: TelegramHandlerDeps) => Promise<string>;

const COMMANDS: Record<string, CommandFn> = {
  "/status": async (_args, deps) => {
    const parts: string[] = [];

    // Resource status
    if (deps.warden) {
      try {
        const res = await deps.warden.getResourceStatus();
        parts.push(formatResourceStatus(res));
      } catch (err) {
        parts.push(`📊 *Resources*\n⚠️ Failed to check: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      parts.push("📊 *Resources*\nWarden not active — no resource tracking.");
    }

    // Active sessions
    try {
      const sessions = await deps.sessionManager.list();
      const active = sessions.filter(
        (s) => !["killed", "done", "terminated"].includes(s.status),
      );
      if (active.length > 0) {
        parts.push("");
        parts.push("🖥️ *Active Sessions*");
        for (const s of active) {
          parts.push(`• \`${s.id}\` — ${s.status} (${s.projectId})`);
        }
      } else {
        parts.push("\n🖥️ *Active Sessions*\nNone.");
      }
    } catch (err) {
      parts.push(`\n🖥️ *Sessions*\n⚠️ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Queue summary
    if (deps.warden) {
      const queue = deps.warden.getQueue();
      const pending = queue.filter((q) => q.status === "pending").length;
      const spawning = queue.filter((q) => q.status === "spawning").length;
      const qActive = queue.filter((q) => q.status === "active").length;
      parts.push("");
      parts.push(`📋 *Queue*: ${pending} pending, ${spawning} spawning, ${qActive} active`);
      if (deps.warden.isPaused()) {
        parts.push("⏸️ *Warden is PAUSED*");
      }
    }

    return parts.join("\n");
  },

  "/queue": async (_args, deps) => {
    if (!deps.warden) {
      return "📋 *Queue*\nWarden not active.";
    }
    const items = deps.warden.getQueue();
    const paused = deps.warden.isPaused();
    let msg = formatQueue(items);
    if (paused) {
      msg += "\n\n⏸️ *Warden is PAUSED*";
    }
    return msg;
  },

  "/spawn": async (args, deps) => {
    if (!deps.warden) {
      return "❌ Warden not active — cannot enqueue.";
    }

    const projectId = args[0];
    const issueId = args[1];

    if (!projectId) {
      return "❌ Usage: `/spawn <project> [issue]`\nExample: `/spawn beacon #5`";
    }

    // Validate project exists
    if (!deps.config.projects[projectId]) {
      const available = Object.keys(deps.config.projects).join(", ");
      return `❌ Unknown project \`${projectId}\`.\nAvailable: ${available}`;
    }

    const queueId = deps.warden.enqueue({
      projectId,
      issueId: issueId || undefined,
    });

    return `✅ Enqueued: \`${projectId}\`${issueId ? ` ${issueId}` : ""}\nQueue ID: \`${queueId}\``;
  },

  "/pause": async (_args, deps) => {
    if (!deps.warden) {
      return "❌ Warden not active.";
    }
    if (deps.warden.isPaused()) {
      return "⏸️ Already paused.";
    }
    deps.warden.pause();
    return "⏸️ Warden *paused*. No new sessions will spawn.\nUse /resume to continue.";
  },

  "/resume": async (_args, deps) => {
    if (!deps.warden) {
      return "❌ Warden not active.";
    }
    if (!deps.warden.isPaused()) {
      return "▶️ Already running.";
    }
    deps.warden.resume();
    return "▶️ Warden *resumed*. Scheduling will continue on next tick.";
  },

  "/kill": async (args, deps) => {
    const sessionId = args[0];
    if (!sessionId) {
      // List active sessions to help the user pick
      try {
        const sessions = await deps.sessionManager.list();
        const active = sessions.filter(
          (s) => !["killed", "done", "terminated"].includes(s.status),
        );
        if (active.length === 0) {
          return "🖥️ No active sessions to kill.";
        }
        const lines = ["❌ Usage: `/kill <session-id>`\n", "Active sessions:"];
        for (const s of active) {
          lines.push(`• \`${s.id}\``);
        }
        return lines.join("\n");
      } catch {
        return "❌ Usage: `/kill <session-id>`";
      }
    }

    try {
      const session = await deps.sessionManager.get(sessionId);
      if (!session) {
        return `❌ Session \`${sessionId}\` not found.`;
      }
      await deps.sessionManager.kill(sessionId);
      // Also mark in warden if active
      if (deps.warden) {
        deps.warden.markFailed(sessionId);
      }
      return `💀 Session \`${sessionId}\` killed.`;
    } catch (err) {
      return `❌ Failed to kill \`${sessionId}\`: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  "/help": async () => {
    return [
      "🤖 *Traffic Warden Commands*",
      "",
      "`/status` — Resources + sessions + queue overview",
      "`/queue` — Show the full priority queue",
      "`/spawn <project> [issue]` — Enqueue a new work item",
      "`/pause` — Pause the scheduler",
      "`/resume` — Resume the scheduler",
      "`/kill <session-id>` — Kill a running session",
      "`/help` — Show this message",
    ].join("\n");
  },
};

// ─── Main Handler ────────────────────────────────────────────────────────────

export function createTelegramHandler(deps: TelegramHandlerDeps): TelegramHandler {
  let running = false;
  let offset = 0;
  let abortController: AbortController | null = null;

  const { botToken, chatId } = deps;
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  async function sendMessage(text: string): Promise<void> {
    try {
      const resp = await fetch(`${baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[telegram-handler] sendMessage failed (${resp.status}): ${errText}`);
      }
    } catch (err) {
      console.error("[telegram-handler] sendMessage error:", err instanceof Error ? err.message : err);
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    // Security: only respond to the configured chat ID
    const messageChatId = String(msg.chat.id);
    if (messageChatId !== chatId) {
      console.warn(`[telegram-handler] Ignoring message from unauthorized chat ${messageChatId}`);
      return;
    }

    const text = msg.text.trim();

    // Extract command and args (handle @botname suffix: /command@botname arg1 arg2)
    const match = text.match(/^(\/\w+)(?:@\w+)?\s*(.*)/);
    if (!match) return; // Not a command

    const command = match[1].toLowerCase();
    const args = match[2] ? match[2].split(/\s+/).filter(Boolean) : [];

    const handler = COMMANDS[command];
    if (!handler) {
      // Unknown command — silently ignore to avoid spam
      return;
    }

    try {
      const response = await handler(args, deps);
      await sendMessage(response);
    } catch (err) {
      console.error(`[telegram-handler] Command ${command} failed:`, err);
      await sendMessage(`❌ Command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function pollLoop(): Promise<void> {
    console.log("[telegram-handler] Polling started");

    while (running) {
      try {
        abortController = new AbortController();
        const url = `${baseUrl}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`;

        const resp = await fetch(url, {
          signal: abortController.signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`[telegram-handler] getUpdates failed (${resp.status}): ${errText}`);
          // Back off on error
          if (running) await sleep(5000);
          continue;
        }

        const data = (await resp.json()) as GetUpdatesResponse;
        if (!data.ok || !data.result) {
          console.error("[telegram-handler] getUpdates returned not ok:", data.description);
          if (running) await sleep(5000);
          continue;
        }

        for (const update of data.result) {
          // Update offset to acknowledge this update
          if (update.update_id >= offset) {
            offset = update.update_id + 1;
          }
          await handleUpdate(update);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Expected when stop() is called
          break;
        }
        console.error("[telegram-handler] Poll error:", err instanceof Error ? err.message : err);
        // Back off on network errors
        if (running) await sleep(5000);
      }
    }

    console.log("[telegram-handler] Polling stopped");
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    start(): void {
      if (!botToken || !chatId) {
        console.warn("[telegram-handler] Missing botToken or chatId — command handler disabled");
        return;
      }
      if (running) {
        console.warn("[telegram-handler] Already running");
        return;
      }
      running = true;
      // Start poll loop in the background (don't await — runs forever)
      pollLoop().catch((err) => {
        console.error("[telegram-handler] Fatal poll error:", err);
        running = false;
      });
    },

    stop(): void {
      running = false;
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
  };
}
