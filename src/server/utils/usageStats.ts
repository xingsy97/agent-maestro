import { EventEmitter } from "events";

import { USAGE_STATS_RETENTION_DAYS } from "../../utils/constant";
import { logger } from "../../utils/logger";

// Histogram bucket boundaries for LLM request durations (seconds)
const DURATION_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];

// Histogram bucket boundaries for token counts per request
const TOKEN_BUCKETS = [
  100, 500, 1000, 5000, 10000, 50000, 100000, 200000, 500000, 1000000,
];

export interface RecordUsageParams {
  /** Effective model ID after fuzzy matching (e.g. "claude-opus-4.6", not the raw requested ID) */
  model: string;
  protocol: "anthropic" | "openai" | "gemini";
  endpoint: string;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: boolean;
  /** Normalized client name derived from User-Agent header */
  client?: string;
}

interface HistogramData {
  bucketCounts: number[]; // cumulative counts for each bucket boundary
  sum: number;
  count: number;
}

interface SerializedHistogram {
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** Per-day counters and histograms (no startTime / uptime — those are global). */
interface DailyData {
  counters: Map<string, number>;
  histograms: Map<string, HistogramData>;
}

export interface SerializedDailyData {
  counters: Record<string, number>;
  histograms: Record<string, SerializedHistogram>;
}

export interface SerializedStats {
  version: 1;
  counters: Record<string, number>;
  histograms: Record<string, SerializedHistogram>;
  startTime: number;
  savedAt: number;
  /** Per-day breakdowns keyed by UTC date string (e.g. "2026-03-29"). */
  daily?: Record<string, SerializedDailyData>;
}

/**
 * Sanitize a Prometheus label value.
 * Escapes backslashes, double-quotes, and newlines per the exposition format spec.
 */
function sanitizeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Build a metric key from a name and label set to serve as map key.
 * Labels are sorted by key for deterministic ordering.
 */
function metricKey(name: string, labels: Record<string, string>): string {
  const sortedLabels = Object.fromEntries(
    Object.keys(labels)
      .sort()
      .map((key) => [key, labels[key]]),
  );
  return `${name}${JSON.stringify(sortedLabels)}`;
}

/**
 * Format labels as Prometheus label string: {key="value",key2="value2"}
 */
function formatLabels(labels: Record<string, string>): string {
  const sortedKeys = Object.keys(labels).sort();
  if (sortedKeys.length === 0) {
    return "";
  }
  const parts = sortedKeys.map(
    (k) => `${k}="${sanitizeLabelValue(labels[k])}"`,
  );
  return `{${parts.join(",")}}`;
}

/** Increment a counter in the given Map. */
function incrementCounter(
  counters: Map<string, number>,
  name: string,
  labels: Record<string, string>,
  amount = 1,
): void {
  const key = metricKey(name, labels);
  const current = counters.get(key) ?? 0;
  counters.set(key, current + amount);
}

/** Observe a value into a histogram in the given Map. */
function observeHistogram(
  histograms: Map<string, HistogramData>,
  name: string,
  labels: Record<string, string>,
  value: number,
  buckets: number[],
): void {
  const key = metricKey(name, labels);
  let data = histograms.get(key);

  if (!data) {
    data = {
      bucketCounts: new Array(buckets.length + 1).fill(0), // +1 for +Inf
      sum: 0,
      count: 0,
    };
    histograms.set(key, data);
  }

  // Ensure bucketCounts length matches (handles restored data with different bucket config)
  while (data.bucketCounts.length < buckets.length + 1) {
    data.bucketCounts.push(0);
  }

  // Cumulative: increment all buckets where value <= boundary
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]) {
      data.bucketCounts[i]++;
    }
  }
  // +Inf bucket always incremented
  data.bucketCounts[buckets.length]++;

  data.sum += value;
  data.count++;
}

/** Get today's date as a UTC string (e.g. "2026-03-29"). */
function getUTCDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get the cutoff date string for retention pruning. Dates before this should be deleted. */
function getCutoffDateString(retentionDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a raw User-Agent string for use as a client label.
 * Returns the raw UA string (truncated to 80 chars) to preserve detail.
 */
export function normalizeUserAgent(rawUA: string): string {
  if (!rawUA) {
    return "(empty)";
  }
  return rawUA.trim().slice(0, 80);
}

/**
 * Aggregates token usage statistics in memory and provides
 * Prometheus exposition format output and JSON serialization for persistence.
 *
 * Design decisions for token counting accuracy:
 * - Always uses the effective (post-fuzzy-match) model ID, not the raw requested model ID,
 *   to avoid label cardinality explosion from variant spellings.
 * - For Anthropic protocol: callers should pass calibrated token counts (scaled by tokenCountScaleFactor)
 *   since that's what downstream consumers see. The raw vs calibrated distinction is a concern of the
 *   route handler, not the stats collector.
 * - For OpenAI/Gemini: token counts come directly from VS Code's countTokens() API — rough estimates
 *   but the best available without calling the actual upstream API.
 */
export class UsageStatsCollector extends EventEmitter {
  private counters = new Map<string, number>();
  private histograms = new Map<string, HistogramData>();
  private dailyData = new Map<string, DailyData>();
  private startTime = Date.now();

  constructor() {
    super();
  }

  recordUsage(params: RecordUsageParams): void {
    const {
      model,
      protocol,
      endpoint,
      stream,
      inputTokens,
      outputTokens,
      durationMs,
      error,
    } = params;

    const fullLabels: Record<string, string> = {
      model,
      protocol,
      endpoint,
      stream: String(stream),
    };

    const shortLabels: Record<string, string> = {
      model,
      protocol,
    };

    // --- Global (all-time) counters & histograms ---
    this.recordToMaps(
      this.counters,
      this.histograms,
      fullLabels,
      shortLabels,
      inputTokens,
      outputTokens,
      durationMs,
      error,
    );

    // --- Daily counters & histograms ---
    const dateKey = getUTCDateString();
    let daily = this.dailyData.get(dateKey);
    if (!daily) {
      daily = { counters: new Map(), histograms: new Map() };
      this.dailyData.set(dateKey, daily);
    }
    this.recordToMaps(
      daily.counters,
      daily.histograms,
      fullLabels,
      shortLabels,
      inputTokens,
      outputTokens,
      durationMs,
      error,
    );

    // --- Client (User-Agent) counter ---
    if (params.client) {
      const clientLabels = { client: params.client };
      incrementCounter(this.counters, "agent_maestro_requests_by_client", clientLabels);
      incrementCounter(this.counters, "agent_maestro_input_tokens_by_client", clientLabels, inputTokens);
      incrementCounter(this.counters, "agent_maestro_output_tokens_by_client", clientLabels, outputTokens);
      incrementCounter(daily.counters, "agent_maestro_requests_by_client", clientLabels);
      incrementCounter(daily.counters, "agent_maestro_input_tokens_by_client", clientLabels, inputTokens);
      incrementCounter(daily.counters, "agent_maestro_output_tokens_by_client", clientLabels, outputTokens);
    }

    this.emit("update");
  }

  toPrometheusText(version?: string): string {
    const lines: string[] = [];

    // Static info gauge
    if (version) {
      lines.push(
        "# HELP agent_maestro_server_info Agent Maestro server information",
        "# TYPE agent_maestro_server_info gauge",
        `agent_maestro_server_info{version="${sanitizeLabelValue(version)}"} 1`,
        "",
      );
    }

    // Uptime gauge
    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    lines.push(
      "# HELP agent_maestro_server_uptime_seconds Server uptime in seconds",
      "# TYPE agent_maestro_server_uptime_seconds gauge",
      `agent_maestro_server_uptime_seconds ${uptimeSeconds.toFixed(1)}`,
      "",
    );

    // Group counters and histograms by metric name for proper HELP/TYPE output
    this.appendCounterMetrics(
      lines,
      "agent_maestro_requests_total",
      "Total number of LLM API requests",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_requests_errors_total",
      "Total number of failed LLM API requests",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_input_tokens_total",
      "Total input tokens consumed",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_output_tokens_total",
      "Total output tokens generated",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_requests_by_client",
      "Requests broken down by client application",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_input_tokens_by_client",
      "Input tokens broken down by client application",
    );
    this.appendCounterMetrics(
      lines,
      "agent_maestro_output_tokens_by_client",
      "Output tokens broken down by client application",
    );

    this.appendHistogramMetrics(
      lines,
      "agent_maestro_request_duration_seconds",
      "LLM API request duration in seconds",
      DURATION_BUCKETS,
    );
    this.appendHistogramMetrics(
      lines,
      "agent_maestro_input_tokens_per_request",
      "Input tokens per request distribution",
      TOKEN_BUCKETS,
    );
    this.appendHistogramMetrics(
      lines,
      "agent_maestro_output_tokens_per_request",
      "Output tokens per request distribution",
      TOKEN_BUCKETS,
    );

    return lines.join("\n") + "\n";
  }

  toJSON(): SerializedStats {
    // Prune stale daily snapshots before serializing
    this.pruneOldDays();

    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }

    const histograms: Record<string, SerializedHistogram> = {};
    for (const [key, data] of this.histograms) {
      histograms[key] = {
        bucketCounts: [...data.bucketCounts],
        sum: data.sum,
        count: data.count,
      };
    }

    const daily: Record<string, SerializedDailyData> = {};
    for (const [dateKey, dayData] of this.dailyData) {
      const dc: Record<string, number> = {};
      for (const [k, v] of dayData.counters) {
        dc[k] = v;
      }
      const dh: Record<string, SerializedHistogram> = {};
      for (const [k, h] of dayData.histograms) {
        dh[k] = {
          bucketCounts: [...h.bucketCounts],
          sum: h.sum,
          count: h.count,
        };
      }
      daily[dateKey] = { counters: dc, histograms: dh };
    }

    return {
      version: 1,
      counters,
      histograms,
      startTime: this.startTime,
      savedAt: Date.now(),
      daily,
    };
  }

  /**
   * Load stats from serialized JSON.
   * @param merge If true, take max(existing, loaded) for counters and histograms
   *              instead of replacing. This prevents counter regression when
   *              multiple instances share the same persistence file.
   */
  loadFromJSON(data: unknown, merge = false): void {
    if (!data || typeof data !== "object") {
      logger.warn("Usage stats: invalid data, skipping load");
      return;
    }

    const stats = data as Record<string, unknown>;

    if (stats.version !== 1) {
      logger.warn(
        `Usage stats: unsupported version ${stats.version}, skipping load`,
      );
      return;
    }

    const parsed = data as SerializedStats;

    // Restore counters (merge mode: take max to prevent regression)
    if (parsed.counters && typeof parsed.counters === "object") {
      for (const [key, value] of Object.entries(parsed.counters)) {
        if (typeof value === "number" && isFinite(value)) {
          if (merge) {
            const current = this.counters.get(key) ?? 0;
            this.counters.set(key, Math.max(current, value));
          } else {
            this.counters.set(key, value);
          }
        }
      }
    }

    // Restore histograms (merge mode: take max for each bucket/sum/count)
    if (parsed.histograms && typeof parsed.histograms === "object") {
      for (const [key, hist] of Object.entries(parsed.histograms)) {
        if (
          hist &&
          Array.isArray(hist.bucketCounts) &&
          typeof hist.sum === "number" &&
          typeof hist.count === "number"
        ) {
          if (merge) {
            const existing = this.histograms.get(key);
            if (existing) {
              const maxLen = Math.max(existing.bucketCounts.length, hist.bucketCounts.length);
              const mergedBuckets = new Array(maxLen).fill(0);
              for (let i = 0; i < maxLen; i++) {
                mergedBuckets[i] = Math.max(
                  existing.bucketCounts[i] ?? 0,
                  hist.bucketCounts[i] ?? 0,
                );
              }
              this.histograms.set(key, {
                bucketCounts: mergedBuckets,
                sum: Math.max(existing.sum, hist.sum),
                count: Math.max(existing.count, hist.count),
              });
            } else {
              this.histograms.set(key, {
                bucketCounts: [...hist.bucketCounts],
                sum: hist.sum,
                count: hist.count,
              });
            }
          } else {
            this.histograms.set(key, {
              bucketCounts: [...hist.bucketCounts],
              sum: hist.sum,
              count: hist.count,
            });
          }
        }
      }
    }

    // Restore startTime (keep the earlier of current or stored, for accurate uptime)
    if (typeof parsed.startTime === "number" && parsed.startTime > 0) {
      this.startTime = Math.min(this.startTime, parsed.startTime);
    }

    // Restore daily breakdowns (merge mode: take max per counter/histogram)
    if (parsed.daily && typeof parsed.daily === "object") {
      for (const [dateKey, dayData] of Object.entries(parsed.daily)) {
        if (!dayData || typeof dayData !== "object") {
          continue;
        }

        const existing = merge ? this.dailyData.get(dateKey) : undefined;
        const daily: DailyData = existing ?? {
          counters: new Map(),
          histograms: new Map(),
        };

        if (dayData.counters && typeof dayData.counters === "object") {
          for (const [k, v] of Object.entries(dayData.counters)) {
            if (typeof v === "number" && isFinite(v)) {
              if (merge) {
                daily.counters.set(k, Math.max(daily.counters.get(k) ?? 0, v));
              } else {
                daily.counters.set(k, v);
              }
            }
          }
        }
        if (dayData.histograms && typeof dayData.histograms === "object") {
          for (const [k, h] of Object.entries(dayData.histograms)) {
            if (
              h &&
              Array.isArray(h.bucketCounts) &&
              typeof h.sum === "number" &&
              typeof h.count === "number"
            ) {
              if (merge) {
                const ex = daily.histograms.get(k);
                if (ex) {
                  const maxLen = Math.max(ex.bucketCounts.length, h.bucketCounts.length);
                  const mb = new Array(maxLen).fill(0);
                  for (let i = 0; i < maxLen; i++) {
                    mb[i] = Math.max(ex.bucketCounts[i] ?? 0, h.bucketCounts[i] ?? 0);
                  }
                  daily.histograms.set(k, {
                    bucketCounts: mb,
                    sum: Math.max(ex.sum, h.sum),
                    count: Math.max(ex.count, h.count),
                  });
                } else {
                  daily.histograms.set(k, {
                    bucketCounts: [...h.bucketCounts],
                    sum: h.sum,
                    count: h.count,
                  });
                }
              } else {
                daily.histograms.set(k, {
                  bucketCounts: [...h.bucketCounts],
                  sum: h.sum,
                  count: h.count,
                });
              }
            }
          }
        }

        if (daily.counters.size > 0 || daily.histograms.size > 0) {
          this.dailyData.set(dateKey, daily);
        }
      }
    }

    // Prune daily data older than retention period
    this.pruneOldDays();

    logger.info(
      `Usage stats ${merge ? "merged" : "loaded"}: ${this.counters.size} counters, ${this.histograms.size} histograms, ${this.dailyData.size} daily snapshots`,
    );
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.dailyData.clear();
    this.startTime = Date.now();
  }

  // --- Private helpers ---

  /**
   * Record counters and histograms into the given Maps.
   * Used by both global and per-day recording to avoid code duplication.
   */
  private recordToMaps(
    counters: Map<string, number>,
    histograms: Map<string, HistogramData>,
    fullLabels: Record<string, string>,
    shortLabels: Record<string, string>,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    error?: boolean,
  ): void {
    incrementCounter(counters, "agent_maestro_requests_total", fullLabels);

    if (error) {
      incrementCounter(
        counters,
        "agent_maestro_requests_errors_total",
        fullLabels,
      );
    }

    incrementCounter(
      counters,
      "agent_maestro_input_tokens_total",
      fullLabels,
      inputTokens,
    );
    incrementCounter(
      counters,
      "agent_maestro_output_tokens_total",
      fullLabels,
      outputTokens,
    );

    const durationSeconds = durationMs / 1000;
    observeHistogram(
      histograms,
      "agent_maestro_request_duration_seconds",
      fullLabels,
      durationSeconds,
      DURATION_BUCKETS,
    );
    observeHistogram(
      histograms,
      "agent_maestro_input_tokens_per_request",
      shortLabels,
      inputTokens,
      TOKEN_BUCKETS,
    );
    observeHistogram(
      histograms,
      "agent_maestro_output_tokens_per_request",
      shortLabels,
      outputTokens,
      TOKEN_BUCKETS,
    );
  }

  /** Remove daily snapshots older than the retention period. */
  private pruneOldDays(): void {
    const cutoff = getCutoffDateString(USAGE_STATS_RETENTION_DAYS);
    const keysToDelete = [...this.dailyData.keys()].filter((k) => k < cutoff);
    for (const key of keysToDelete) {
      this.dailyData.delete(key);
    }
  }

  private appendCounterMetrics(
    lines: string[],
    name: string,
    help: string,
  ): void {
    const prefix = `${name}{`;
    const matchingEntries: [string, number][] = [];

    for (const [key, value] of this.counters) {
      if (key.startsWith(prefix)) {
        matchingEntries.push([key, value]);
      }
    }

    if (matchingEntries.length === 0) {
      return;
    }

    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [key, value] of matchingEntries) {
      // key is "name{labels}", extract labels part
      const labelsStr = key.slice(name.length);
      const formattedLabels = this.parseAndFormatLabels(labelsStr);
      lines.push(`${name}${formattedLabels} ${value}`);
    }
    lines.push("");
  }

  private appendHistogramMetrics(
    lines: string[],
    name: string,
    help: string,
    buckets: number[],
  ): void {
    const prefix = `${name}{`;
    const matchingEntries: [string, HistogramData][] = [];

    for (const [key, data] of this.histograms) {
      if (key.startsWith(prefix)) {
        matchingEntries.push([key, data]);
      }
    }

    if (matchingEntries.length === 0) {
      return;
    }

    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
    for (const [key, data] of matchingEntries) {
      const rawLabels = this.parseLabelsFromKey(key.slice(name.length));

      // Bucket lines
      for (let i = 0; i < buckets.length; i++) {
        const bucketLabels = { ...rawLabels, le: String(buckets[i]) };
        lines.push(
          `${name}_bucket${formatLabels(bucketLabels)} ${data.bucketCounts[i]}`,
        );
      }
      // +Inf bucket
      const infLabels = { ...rawLabels, le: "+Inf" };
      lines.push(
        `${name}_bucket${formatLabels(infLabels)} ${data.bucketCounts[buckets.length]}`,
      );

      // Sum and count
      const baseLabels = formatLabels(rawLabels);
      lines.push(`${name}_sum${baseLabels} ${data.sum}`);
      lines.push(`${name}_count${baseLabels} ${data.count}`);
    }
    lines.push("");
  }

  /**
   * Parse labels from the internal key format {k1=v1,k2=v2} back into a Record.
   * Values are stored raw (without quotes) in the internal key format.
   */
  private parseLabelsFromKey(labelsStr: string): Record<string, string> {
    try {
      const parsed = JSON.parse(labelsStr);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  }

  /**
   * Convert internal key labels format to properly quoted Prometheus label string.
   */
  private parseAndFormatLabels(labelsStr: string): string {
    const labels = this.parseLabelsFromKey(labelsStr);
    return formatLabels(labels);
  }
}
