import { OpenAPIHono } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { UsageStatsCollector } from "../utils/usageStats";

export function registerMetricsRoute(
  app: OpenAPIHono<any>,
  collector: UsageStatsCollector,
  version?: string,
) {
  app.get("/metrics", (c: Context) => {
    const body = collector.toPrometheusText(version);
    return c.text(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  app.get("/metrics/json", (c: Context) => {
    return c.json(collector.toJSON());
  });

  app.get("/metrics/stream", (c: Context) => {
    return streamSSE(c, async (stream) => {
      let id = 0;
      let sending = false;
      let pending = false;

      // Allow many concurrent SSE connections without EventEmitter warnings
      collector.setMaxListeners(collector.getMaxListeners() + 1);

      const send = async () => {
        if (sending) {
          pending = true;
          return;
        }
        sending = true;
        try {
          await stream.writeSSE({
            data: JSON.stringify(collector.toJSON()),
            event: "stats",
            id: String(id++),
          });
        } finally {
          sending = false;
          if (pending) {
            pending = false;
            send().catch(() => {});
          }
        }
      };

      // Send initial data immediately
      await send();

      // Push on every usage update
      const onUpdate = () => {
        send().catch(() => {});
      };
      collector.on("update", onUpdate);

      // Heartbeat every 30s to keep connection alive and refresh uptime
      const heartbeat = setInterval(() => {
        send().catch(() => {});
      }, 30_000);

      // Keep stream open — wait until aborted, then clean up
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          collector.off("update", onUpdate);
          clearInterval(heartbeat);
          collector.setMaxListeners(
            Math.max(1, collector.getMaxListeners() - 1),
          );
          resolve();
        });
      });
    });
  });
}
