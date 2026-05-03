import * as assert from "assert";

import {
  type SerializedDailyData,
  type SerializedStats,
  UsageStatsCollector,
  normalizeUserAgent,
} from "../../server/utils/usageStats";

suite("UsageStatsCollector", () => {
  let collector: UsageStatsCollector;

  setup(() => {
    collector = new UsageStatsCollector();
  });

  suite("recordUsage + toPrometheusText", () => {
    test("should record a single request and expose counters", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      });

      const text = collector.toPrometheusText();

      // Counter metrics
      assert.ok(text.includes("agent_maestro_requests_total"));
      assert.ok(
        text.includes(
          'agent_maestro_requests_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 1',
        ),
      );
      assert.ok(
        text.includes(
          'agent_maestro_input_tokens_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 1000',
        ),
      );
      assert.ok(
        text.includes(
          'agent_maestro_output_tokens_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 200',
        ),
      );

      // Should NOT have error counter (no error recorded)
      assert.ok(!text.includes("agent_maestro_requests_errors_total"));
    });

    test("should record error requests", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: true,
        inputTokens: 500,
        outputTokens: 0,
        durationMs: 1000,
        error: true,
      });

      const text = collector.toPrometheusText();
      assert.ok(
        text.includes(
          'agent_maestro_requests_errors_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="true"} 1',
        ),
      );
    });

    test("should accumulate counters across multiple calls", () => {
      for (let i = 0; i < 3; i++) {
        collector.recordUsage({
          model: "gpt-4o",
          protocol: "openai",
          endpoint: "/v1/chat/completions",
          stream: true,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 2000,
        });
      }

      const text = collector.toPrometheusText();
      assert.ok(
        text.includes(
          'agent_maestro_requests_total{endpoint="/v1/chat/completions",model="gpt-4o",protocol="openai",stream="true"} 3',
        ),
      );
      assert.ok(
        text.includes(
          'agent_maestro_input_tokens_total{endpoint="/v1/chat/completions",model="gpt-4o",protocol="openai",stream="true"} 300',
        ),
      );
      assert.ok(
        text.includes(
          'agent_maestro_output_tokens_total{endpoint="/v1/chat/completions",model="gpt-4o",protocol="openai",stream="true"} 150',
        ),
      );
    });

    test("should keep separate counters for different label combinations", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      });
      collector.recordUsage({
        model: "gpt-4o",
        protocol: "openai",
        endpoint: "/v1/chat/completions",
        stream: true,
        inputTokens: 500,
        outputTokens: 100,
        durationMs: 3000,
      });

      const text = collector.toPrometheusText();

      // Both should exist independently
      assert.ok(
        text.includes(
          'agent_maestro_requests_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 1',
        ),
      );
      assert.ok(
        text.includes(
          'agent_maestro_requests_total{endpoint="/v1/chat/completions",model="gpt-4o",protocol="openai",stream="true"} 1',
        ),
      );
    });
  });

  suite("histogram metrics", () => {
    test("should produce correct cumulative histogram buckets for duration", () => {
      // Record a request with 5s duration → should fall in le="5" and all higher buckets
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 5000, // 5 seconds
      });

      const text = collector.toPrometheusText();

      // Buckets: 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300
      // 5s should be <= 5, so buckets 0.5=0, 1=0, 2=0, 5=1, 10=1, 20=1, 30=1, 60=1, 120=1, 300=1, +Inf=1
      assert.ok(text.includes('le="0.5"} 0'));
      assert.ok(text.includes('le="1"} 0'));
      assert.ok(text.includes('le="2"} 0'));
      assert.ok(text.includes('le="5"} 1'));
      assert.ok(text.includes('le="10"} 1'));
      assert.ok(text.includes('le="+Inf"} 1'));

      // Sum and count
      assert.ok(text.includes("agent_maestro_request_duration_seconds_sum"));
      assert.ok(text.includes("agent_maestro_request_duration_seconds_count"));
    });

    test("should produce correct histogram for token distributions", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 5000,
        outputTokens: 200,
        durationMs: 3000,
      });

      const text = collector.toPrometheusText();

      // Token histograms use shortLabels (model, protocol only)
      assert.ok(text.includes("agent_maestro_input_tokens_per_request"));
      assert.ok(text.includes("agent_maestro_output_tokens_per_request"));
    });
  });

  suite("Prometheus format compliance", () => {
    test("should include HELP and TYPE lines for each metric", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();

      assert.ok(text.includes("# HELP agent_maestro_requests_total"));
      assert.ok(text.includes("# TYPE agent_maestro_requests_total counter"));
      assert.ok(text.includes("# HELP agent_maestro_input_tokens_total"));
      assert.ok(
        text.includes("# TYPE agent_maestro_input_tokens_total counter"),
      );
      assert.ok(text.includes("# HELP agent_maestro_request_duration_seconds"));
      assert.ok(
        text.includes(
          "# TYPE agent_maestro_request_duration_seconds histogram",
        ),
      );
    });

    test("should include version info gauge when version is provided", () => {
      const text = collector.toPrometheusText("2.8.5");

      assert.ok(text.includes("# HELP agent_maestro_server_info"));
      assert.ok(text.includes("# TYPE agent_maestro_server_info gauge"));
      assert.ok(text.includes('agent_maestro_server_info{version="2.8.5"} 1'));
    });

    test("should not include version info when version is omitted", () => {
      const text = collector.toPrometheusText();
      assert.ok(!text.includes("agent_maestro_server_info"));
    });

    test("should include uptime gauge", () => {
      const text = collector.toPrometheusText();
      assert.ok(text.includes("agent_maestro_server_uptime_seconds"));
    });

    test("should sanitize label values with special characters", () => {
      collector.recordUsage({
        model: 'model"with\\quotes\nnewline',
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();

      // Should have escaped quotes and backslashes
      assert.ok(text.includes('\\"'));
      assert.ok(text.includes("\\\\"));
      assert.ok(text.includes("\\n"));
    });

    test("should sort labels alphabetically", () => {
      collector.recordUsage({
        model: "test-model",
        protocol: "openai",
        endpoint: "/test",
        stream: true,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();

      // Labels should appear in alphabetical order: endpoint, model, protocol, stream
      const match = text.match(/agent_maestro_requests_total\{([^}]+)\}/);
      assert.ok(match, "Should find requests_total metric with labels");
      const labels = match![1];
      const labelKeys = labels.split(",").map((l: string) => l.split("=")[0]);
      assert.deepStrictEqual(labelKeys, [
        "endpoint",
        "model",
        "protocol",
        "stream",
      ]);
    });

    test("should end with a newline", () => {
      const text = collector.toPrometheusText();
      assert.ok(text.endsWith("\n"));
    });
  });

  suite("toJSON / loadFromJSON", () => {
    test("should round-trip serialize and restore counters", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      });

      const json = collector.toJSON();
      assert.strictEqual(json.version, 1);
      assert.ok(json.startTime > 0);
      assert.ok(json.savedAt >= json.startTime);

      // Create a new collector and restore
      const restored = new UsageStatsCollector();
      restored.loadFromJSON(json);

      // Add another request to the restored collector
      restored.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 500,
        outputTokens: 100,
        durationMs: 3000,
      });

      const text = restored.toPrometheusText();
      // Should have accumulated: 1000 + 500 = 1500 input tokens
      assert.ok(
        text.includes(
          'agent_maestro_input_tokens_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 1500',
        ),
      );
      // 2 requests total
      assert.ok(
        text.includes(
          'agent_maestro_requests_total{endpoint="/v1/messages",model="claude-opus-4.6",protocol="anthropic",stream="false"} 2',
        ),
      );
    });

    test("should round-trip histograms", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 2000,
      });

      const json = collector.toJSON();
      const restored = new UsageStatsCollector();
      restored.loadFromJSON(json);

      const originalText = collector.toPrometheusText();
      const restoredText = restored.toPrometheusText();

      // Histogram data should match (uptime may differ slightly, so check specific metrics)
      const extractHistogram = (text: string, name: string) => {
        const lines = text.split("\n");
        return lines.filter(
          (l) =>
            l.startsWith(`${name}_bucket`) ||
            l.startsWith(`${name}_sum`) ||
            l.startsWith(`${name}_count`),
        );
      };

      assert.deepStrictEqual(
        extractHistogram(
          originalText,
          "agent_maestro_request_duration_seconds",
        ),
        extractHistogram(
          restoredText,
          "agent_maestro_request_duration_seconds",
        ),
      );
    });

    test("should preserve earlier startTime on load", () => {
      const json = collector.toJSON();
      const earlierStart = json.startTime - 60000; // 1 minute earlier
      json.startTime = earlierStart;

      const restored = new UsageStatsCollector();
      restored.loadFromJSON(json);

      // The uptime should reflect the earlier startTime
      const text = restored.toPrometheusText();
      const uptimeMatch = text.match(
        /agent_maestro_server_uptime_seconds (\d+\.\d+)/,
      );
      assert.ok(uptimeMatch);
      const uptime = parseFloat(uptimeMatch![1]);
      // Should be at least 60 seconds (from the earlier start)
      assert.ok(uptime >= 59, `Uptime ${uptime} should be >= 59s`);
    });

    test("should handle invalid data gracefully", () => {
      // Should not throw on null/undefined/invalid
      collector.loadFromJSON(null);
      collector.loadFromJSON(undefined);
      collector.loadFromJSON("invalid");
      collector.loadFromJSON({ version: 2 }); // unsupported version
      collector.loadFromJSON({ version: 1, counters: null, histograms: null }); // null fields

      // Should still work after invalid loads
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();
      assert.ok(text.includes("agent_maestro_requests_total"));
    });

    test("should ignore non-finite counter values during load", () => {
      const json: SerializedStats = {
        version: 1,
        counters: {
          "agent_maestro_requests_total{model=test,protocol=anthropic}":
            Infinity,
          "agent_maestro_input_tokens_total{model=test,protocol=anthropic}":
            NaN,
          "agent_maestro_output_tokens_total{model=test,protocol=anthropic}": 42,
        },
        histograms: {},
        startTime: Date.now(),
        savedAt: Date.now(),
      };

      collector.loadFromJSON(json);
      const reserialized = collector.toJSON();

      // Infinity and NaN should be skipped, only 42 should be present
      const counterKeys = Object.keys(reserialized.counters);
      assert.strictEqual(counterKeys.length, 1);
      assert.ok(counterKeys[0].includes("output_tokens_total"));
    });
  });

  suite("loadFromJSON merge mode", () => {
    test("should take max of counters when merge=true", () => {
      // Simulate instance A with higher values
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 5000,
        outputTokens: 1000,
        durationMs: 3000,
      });

      // Serialize current state (5000 input tokens)
      const fileData: SerializedStats = {
        version: 1,
        counters: {
          'agent_maestro_input_tokens_total{endpoint=/v1/messages,model=claude-opus-4.6,protocol=anthropic,stream=false}': 8000,
          'agent_maestro_output_tokens_total{endpoint=/v1/messages,model=claude-opus-4.6,protocol=anthropic,stream=false}': 500,
        },
        histograms: {},
        startTime: Date.now(),
        savedAt: Date.now(),
      };

      // Merge: input should take 8000 (file), output should keep 1000 (memory)
      collector.loadFromJSON(fileData, true);
      const json = collector.toJSON();
      const inputKey = 'agent_maestro_input_tokens_total{endpoint=/v1/messages,model=claude-opus-4.6,protocol=anthropic,stream=false}';
      const outputKey = 'agent_maestro_output_tokens_total{endpoint=/v1/messages,model=claude-opus-4.6,protocol=anthropic,stream=false}';
      assert.strictEqual(json.counters[inputKey], 8000); // file was higher
      assert.strictEqual(json.counters[outputKey], 1000); // memory was higher
    });

    test("should take max of histogram data when merge=true", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 2000,
      });

      const json = collector.toJSON();

      // Create a second collector and merge with higher histogram values
      const collector2 = new UsageStatsCollector();
      collector2.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 2000,
      });
      collector2.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 200,
        outputTokens: 100,
        durationMs: 3000,
      });

      const json2 = collector2.toJSON();

      // Merge json2 into collector (which has lower values)
      collector.loadFromJSON(json2, true);
      const merged = collector.toJSON();

      // Histogram count should be max(1, 2) = 2
      const histKey = Object.keys(merged.histograms).find((k) =>
        k.includes("request_duration_seconds"),
      );
      assert.ok(histKey);
      assert.strictEqual(merged.histograms[histKey!].count, 2);
    });

    test("should not regress counters when merge=true with lower values from file", () => {
      collector.recordUsage({
        model: "gpt-4",
        protocol: "openai",
        endpoint: "/v1/responses",
        stream: true,
        inputTokens: 100000,
        outputTokens: 20000,
        durationMs: 5000,
      });

      // File has lower values (simulating stale instance)
      const staleData: SerializedStats = {
        version: 1,
        counters: {
          'agent_maestro_input_tokens_total{endpoint=/v1/responses,model=gpt-4,protocol=openai,stream=true}': 50000,
          'agent_maestro_output_tokens_total{endpoint=/v1/responses,model=gpt-4,protocol=openai,stream=true}': 10000,
        },
        histograms: {},
        startTime: Date.now(),
        savedAt: Date.now(),
      };

      collector.loadFromJSON(staleData, true);
      const json = collector.toJSON();
      const inputKey = 'agent_maestro_input_tokens_total{endpoint=/v1/responses,model=gpt-4,protocol=openai,stream=true}';
      // Should keep 100000, not regress to 50000
      assert.strictEqual(json.counters[inputKey], 100000);
    });
  });

  suite("reset", () => {
    test("should clear all counters and histograms", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      });

      collector.reset();

      const text = collector.toPrometheusText();

      // Should only have uptime, no counters or histograms
      assert.ok(!text.includes("agent_maestro_requests_total"));
      assert.ok(!text.includes("agent_maestro_input_tokens_total"));
      assert.ok(
        !text.includes("agent_maestro_request_duration_seconds_bucket"),
      );

      // Uptime should still be present (reset restarts timer)
      assert.ok(text.includes("agent_maestro_server_uptime_seconds"));
    });
  });

  suite("edge cases", () => {
    test("should handle zero token counts", () => {
      collector.recordUsage({
        model: "test",
        protocol: "openai",
        endpoint: "/test",
        stream: false,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 100,
      });

      const text = collector.toPrometheusText();
      assert.ok(text.includes("agent_maestro_requests_total"));
      // 0 tokens should show up in counters
      assert.ok(
        text.includes(
          'agent_maestro_input_tokens_total{endpoint="/test",model="test",protocol="openai",stream="false"} 0',
        ),
      );
    });

    test("should handle very large token counts", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 999999,
        outputTokens: 500000,
        durationMs: 120000,
      });

      const text = collector.toPrometheusText();
      assert.ok(text.includes("999999"));
      assert.ok(text.includes("500000"));
    });

    test("should produce valid output with no recorded usage", () => {
      const text = collector.toPrometheusText("1.0.0");
      // Should still have info and uptime even with no requests
      assert.ok(text.includes("agent_maestro_server_info"));
      assert.ok(text.includes("agent_maestro_server_uptime_seconds"));
      assert.ok(text.endsWith("\n"));
    });
  });

  suite("daily granularity", () => {
    test("recordUsage should dual-write to both global and daily maps", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      });

      const json = collector.toJSON();

      // Global counters should exist
      const globalKeys = Object.keys(json.counters);
      assert.ok(globalKeys.length > 0, "Should have global counters");

      // Daily data should exist with today's date key
      assert.ok(json.daily, "Should have daily field");
      const dateKeys = Object.keys(json.daily!);
      assert.strictEqual(dateKeys.length, 1, "Should have exactly one date");

      // Date key should be a valid YYYY-MM-DD format
      assert.ok(
        /^\d{4}-\d{2}-\d{2}$/.test(dateKeys[0]),
        `Date key "${dateKeys[0]}" should be YYYY-MM-DD format`,
      );

      // Daily counters should mirror global counters
      const dayData = json.daily![dateKeys[0]];
      assert.ok(dayData.counters, "Daily data should have counters");
      assert.ok(dayData.histograms, "Daily data should have histograms");

      // Check specific counter values match global
      for (const key of Object.keys(dayData.counters)) {
        assert.strictEqual(
          dayData.counters[key],
          json.counters[key],
          `Daily counter ${key} should match global`,
        );
      }
    });

    test("should round-trip daily data through serialize/deserialize", () => {
      collector.recordUsage({
        model: "gpt-4o",
        protocol: "openai",
        endpoint: "/v1/chat/completions",
        stream: true,
        inputTokens: 500,
        outputTokens: 100,
        durationMs: 2000,
      });
      collector.recordUsage({
        model: "gpt-4o",
        protocol: "openai",
        endpoint: "/v1/chat/completions",
        stream: false,
        inputTokens: 300,
        outputTokens: 80,
        durationMs: 1500,
      });

      const json = collector.toJSON();
      const restored = new UsageStatsCollector();
      restored.loadFromJSON(json);

      const restoredJson = restored.toJSON();

      // Daily data should survive round-trip
      assert.ok(restoredJson.daily, "Restored should have daily field");
      const originalDates = Object.keys(json.daily!).sort();
      const restoredDates = Object.keys(restoredJson.daily!).sort();
      assert.deepStrictEqual(restoredDates, originalDates);

      // Counter values should match
      for (const dateKey of originalDates) {
        const origDay = json.daily![dateKey];
        const restDay: SerializedDailyData = restoredJson.daily![dateKey];
        assert.deepStrictEqual(restDay.counters, origDay.counters);
      }
    });

    test("should prune daily data older than retention period on load", () => {
      // Manually construct serialized data with old dates
      const today = new Date().toISOString().slice(0, 10);
      const oldDate = "2020-01-01"; // Definitely > 180 days ago

      const json: SerializedStats = {
        version: 1,
        counters: {
          "agent_maestro_requests_total{endpoint=/test,model=test,protocol=anthropic,stream=false}": 10,
        },
        histograms: {},
        startTime: Date.now(),
        savedAt: Date.now(),
        daily: {
          [today]: {
            counters: {
              "agent_maestro_requests_total{endpoint=/test,model=test,protocol=anthropic,stream=false}": 5,
            },
            histograms: {},
          },
          [oldDate]: {
            counters: {
              "agent_maestro_requests_total{endpoint=/test,model=test,protocol=anthropic,stream=false}": 5,
            },
            histograms: {},
          },
        },
      };

      collector.loadFromJSON(json);
      const result = collector.toJSON();

      assert.ok(result.daily, "Should have daily field");
      const dates = Object.keys(result.daily!);

      // Today should still exist
      assert.ok(dates.includes(today), "Today's data should be kept");
      // Old date should be pruned
      assert.ok(!dates.includes(oldDate), "Old data should be pruned");
    });

    test("reset should clear daily data", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const beforeReset = collector.toJSON();
      assert.ok(
        Object.keys(beforeReset.daily!).length > 0,
        "Should have daily data before reset",
      );

      collector.reset();

      const afterReset = collector.toJSON();
      assert.strictEqual(
        Object.keys(afterReset.daily!).length,
        0,
        "Should have no daily data after reset",
      );
    });

    test("daily data should not appear in Prometheus text", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();
      // Prometheus output should NOT contain date-related labels
      assert.ok(
        !text.includes("date="),
        "Prometheus text should not include date labels",
      );
    });
  });

  suite("normalizeUserAgent", () => {
    test("should return raw UA string trimmed to 80 chars", () => {
      assert.strictEqual(
        normalizeUserAgent("claude-cli/2.1.76 (external, cli)"),
        "claude-cli/2.1.76 (external, cli)",
      );
      assert.strictEqual(
        normalizeUserAgent("codex_cli_rs/0.117.0 (Ubuntu 24.4.0; x86_64) VTE/7600 (codex-tui; 0.117.0)"),
        "codex_cli_rs/0.117.0 (Ubuntu 24.4.0; x86_64) VTE/7600 (codex-tui; 0.117.0)",
      );
    });

    test("should return '(empty)' for empty or missing UA", () => {
      assert.strictEqual(normalizeUserAgent(""), "(empty)");
    });

    test("should truncate long UA strings to 80 chars", () => {
      const longUA = "a".repeat(120);
      assert.strictEqual(normalizeUserAgent(longUA).length, 80);
    });
  });

  suite("client (UA) tracking", () => {
    test("recordUsage with client should create by_client counter", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
        client: "claude-cli/2.1.76",
      });

      const text = collector.toPrometheusText();
      assert.ok(
        text.includes('agent_maestro_requests_by_client{client="claude-cli/2.1.76"} 1'),
        "Should contain client counter in Prometheus output",
      );
    });

    test("client labels should preserve commas and equals signs", () => {
      collector.recordUsage({
        model: "claude-opus-4.6",
        protocol: "anthropic",
        endpoint: "/v1/messages",
        stream: false,
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
        client: "codex_cli_rs/0.117.0 (Ubuntu; x=a, y=b)",
      });

      const text = collector.toPrometheusText();
      assert.ok(
        text.includes('agent_maestro_requests_by_client{client="codex_cli_rs/0.117.0 (Ubuntu; x=a, y=b)"} 1'),
        "Should preserve client label punctuation in Prometheus output",
      );
    });

    test("recordUsage without client should not create by_client counter", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      });

      const text = collector.toPrometheusText();
      assert.ok(
        !text.includes("agent_maestro_requests_by_client"),
        "Should not contain client counter when client is not provided",
      );
    });

    test("client counter should be included in daily data", () => {
      collector.recordUsage({
        model: "test",
        protocol: "anthropic",
        endpoint: "/test",
        stream: false,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
        client: "cursor/0.45.3",
      });

      const json = collector.toJSON();
      const dateKeys = Object.keys(json.daily!);
      assert.ok(dateKeys.length > 0, "Should have daily data");
      const dayData = json.daily![dateKeys[0]];
      const hasClientCounter = Object.keys(dayData.counters).some(
        (k) => k.includes("requests_by_client"),
      );
      assert.ok(hasClientCounter, "Daily data should include client counter");
    });
  });
});
