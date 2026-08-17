#!/usr/bin/env node

import pg from "pg";
import { parseArgs } from "node:util";

const { values: { since } } = parseArgs({
  args: process.argv.slice(2),
  options: {
    since: {
      type: "string",
      description: "ISO timestamp to check records after"
    }
  }
});

if (!since) {
  console.error("Error: --since parameter is required (ISO timestamp)");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Error: DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString,
  application_name: "canary-hosted-scan",
  max: 2,
  statement_timeout: 30_000,
});

const canaryMarker = "%CANARY-REAL-EGRESS-%";

async function runCanaryChecks() {
  const client = await pool.connect();

  try {
    // Set read-only mode to ensure no accidental writes
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET default_transaction_read_only = on");
    const results = {
      checked_tables: [],
      structural_checks: {},
      marker_hits: {},
      verdict: "fail"
    };

    // 1. 结构断言：检查 journal eligibility 相关记录
    const structuralQueries = [
      {
        table: "workflow_commands",
        query: `
          SELECT COUNT(*) as count
          FROM workflow_commands
          WHERE created_at > $1
          AND intent_key LIKE 'journal-eligibility-%'
        `,
        name: "journal_eligibility_commands"
      },
      {
        table: "workflow_outbox_committs",
        query: `
          SELECT COUNT(*) as count
          FROM workflow_outbox_commits
          WHERE created_at > $1
        `,
        name: "outbox_commits"
      },
      {
        table: "outbox_events",
        query: `
          SELECT COUNT(*) as count
          FROM outbox_events
          WHERE created_at > $1
          AND status = 'delivered'
        `,
        name: "delivered_outbox_events"
      }
    ];

    for (const check of structuralQueries) {
      const result = await client.query(check.query, [since]);
      const count = parseInt(result.rows[0].count);
      results.structural_checks[check.name] = count;
      if (!results.checked_tables.includes(check.table)) {
        results.checked_tables.push(check.table);
      }
    }

    // 2. 无正文断言：检查暗号标记
    const contentCheckQueries = [
      {
        table: "outbox_events",
        column: "payload",
        query: `
          SELECT COUNT(*) as count
          FROM outbox_events
          WHERE payload::text ILIKE $1
        `
      },
      {
        table: "workflow_commands",
        column: "payload",
        query: `
          SELECT COUNT(*) as count
          FROM workflow_commands
          WHERE payload::text ILIKE $1
        `
      },
      {
        table: "daily_session_date_outcomes",
        column: "*",
        query: `
          SELECT COUNT(*) as count
          FROM daily_session_date_outcomes
          WHERE outcome::text ILIKE $1
        `
      }
    ];

    let totalMarkerHits = 0;
    for (const check of contentCheckQueries) {
      const result = await client.query(check.query, [canaryMarker]);
      const count = parseInt(result.rows[0].count);
      results.marker_hits[check.table] = count;
      totalMarkerHits += count;
      if (!results.checked_tables.includes(check.table)) {
        results.checked_tables.push(check.table);
      }
    }

    // 判定结果
    const hasStructuralRecords = Object.values(results.structural_checks).some(count => count > 0);
    const noMarkerLeaks = totalMarkerHits === 0;

    results.verdict = (hasStructuralRecords && noMarkerLeaks) ? "pass" : "fail";

    console.log(JSON.stringify(results, null, 2));

    process.exit(results.verdict === "pass" ? 0 : 1);

  } finally {
    client.release();
    await pool.end();
  }
}

runCanaryChecks().catch(error => {
  console.error("Canary check failed:", error.message);
  process.exit(1);
});
