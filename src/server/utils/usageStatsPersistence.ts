import * as vscode from "vscode";

import {
  USAGE_STATS_FILE_NAME,
  USAGE_STATS_PERSIST_INTERVAL_MS,
} from "../../utils/constant";
import { logger } from "../../utils/logger";
import { UsageStatsCollector } from "./usageStats";

/**
 * Handles on-disk persistence for usage stats.
 *
 * The proxy can run in multiple VS Code windows, but only the instance that
 * owns the server port should periodically write stats. Writes use a
 * read-merge-write flow so a stale instance cannot overwrite higher counters.
 */
export class UsageStatsPersistence {
  private persistInterval?: NodeJS.Timeout;

  constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly usageStats: UsageStatsCollector,
  ) {}

  async restore(): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed = JSON.parse(Buffer.from(data).toString("utf-8"));
      this.usageStats.loadFromJSON(parsed);
    } catch {
      // File doesn't exist or is invalid — start fresh
      logger.debug("No existing usage stats found, starting fresh");
    }
  }

  start(): void {
    if (this.persistInterval) {
      return;
    }

    this.persistInterval = setInterval(() => {
      this.persist().catch((err) => {
        logger.error("Failed to persist usage stats:", err);
      });
    }, USAGE_STATS_PERSIST_INTERVAL_MS);
    logger.debug("Usage stats periodic persistence started");
  }

  async persist(): Promise<void> {
    try {
      // Read existing file and merge (take max) before writing,
      // so we never overwrite a higher value from another instance.
      try {
        const existing = await vscode.workspace.fs.readFile(this.fileUri);
        const parsed = JSON.parse(Buffer.from(existing).toString("utf-8"));
        this.usageStats.loadFromJSON(parsed, true);
      } catch {
        // File doesn't exist yet — that's fine, just write current state
      }

      const data = JSON.stringify(this.usageStats.toJSON());
      await vscode.workspace.fs.writeFile(
        this.fileUri,
        Buffer.from(data, "utf-8"),
      );
    } catch (error) {
      logger.error("Failed to persist usage stats:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = undefined;
    }
    await this.persist();
  }

  private get fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri, USAGE_STATS_FILE_NAME);
  }
}
