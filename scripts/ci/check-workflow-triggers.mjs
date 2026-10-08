#!/usr/bin/env node
// Protects the two GitHub Actions schedules that carry the Internal Owner
// runtime contracts (ADR-0106 recovery scan, ADR-0119 backup renewal).
//
// The checks are intentionally structural and content-free: they assert the
// triggers and the original scan target survive a refactor, and back up the
// behavioural execution in tests/recovery-scan-workflow-behavior.test.ts.
// Point SAYHEAR_WORKFLOW_DIR at a fixture directory to check a mutated copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowDirectory = resolve(
  process.env.SAYHEAR_WORKFLOW_DIR ?? ".github/workflows",
);

const failures = [];
const fail = (message) => failures.push(message);

function readWorkflow(name) {
  try {
    return readFileSync(resolve(workflowDirectory, name), "utf8");
  } catch {
    fail(`${name} is missing from ${workflowDirectory}`);
    return "";
  }
}

// Returns the YAML block for a single `- name:` step, up to (but not
// including) the next step at the same indentation.
function stepBlock(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const lineIndent = line.match(/^\s*/)[0].length;
    if (lineIndent <= indent && /^\s*-\s*name:/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

const recoveryScan = readWorkflow("internal-recovery-scan.yml");
if (recoveryScan) {
  if (
    !/schedule:[^\n]*\n\s*-\s*cron:\s*["']?13 \* \* \* \*["']?/.test(
      recoveryScan,
    )
  ) {
    fail(
      'internal recovery scan must keep the hourly schedule cron "13 * * * *"',
    );
  }
  if (!/workflow_dispatch:/.test(recoveryScan)) {
    fail("internal recovery scan must keep workflow_dispatch");
  }
  if (!/^\s*url:\s*$/m.test(recoveryScan) || !/^\s*mode:\s*$/m.test(recoveryScan)) {
    fail("internal recovery scan must keep the url and mode dispatch inputs");
  }

  const originalScanStep = stepBlock(
    recoveryScan,
    "Call recovery scan endpoint",
  );
  if (!originalScanStep) {
    fail(
      "internal recovery scan must keep the original recovery scan dispatch step",
    );
  } else {
    if (
      !/github\.event_name == 'schedule' \|\| inputs\.url == ''/.test(
        originalScanStep,
      )
    ) {
      fail(
        "original recovery scan step must run on schedule and empty-url dispatch",
      );
    }
    if (!/vars\.RECOVERY_SCAN_URL/.test(originalScanStep)) {
      fail(
        "original recovery scan step must call the configured RECOVERY_SCAN_URL target",
      );
    }
    if (!/\bcurl\b/.test(originalScanStep)) {
      fail("original recovery scan step must issue a curl request");
    }
    if (!/Authorization: Bearer/.test(originalScanStep)) {
      fail("original recovery scan step must authenticate with a Bearer token");
    }
    if (!/http_code/.test(originalScanStep) || !/!= "200"/.test(originalScanStep)) {
      fail("original recovery scan step must fail on a non-200 response");
    }
  }

  const scopedStep = stepBlock(recoveryScan, "Verify scoped production endpoint");
  if (!scopedStep) {
    fail("internal recovery scan must keep the scoped verification step");
  } else {
    if (
      !/github\.event_name == 'workflow_dispatch' && inputs\.url != ''/.test(
        scopedStep,
      )
    ) {
      fail(
        "scoped verification must run only for a url-carrying workflow_dispatch",
      );
    }
    if (
      !/mode === 'identity'[\s\S]{0,120}\/api\/internal\/inspection\/release-identity/.test(
        scopedStep,
      )
    ) {
      fail("identity mode must select the release-identity route");
    }
    if (!scopedStep.includes("/api/internal/recovery/scan")) {
      fail("recovery mode must select the original recovery scan route");
    }
    if (!/Authorization: 'Bearer ' \+ process\.env\.CRON_SECRET/.test(scopedStep)) {
      fail("scoped verification must authenticate with a Bearer token");
    }
  }
}

const backupRenewal = readWorkflow("backup-evidence-renewal.yml");
if (backupRenewal) {
  if (
    !/schedule:[^\n]*\n\s*-\s*cron:\s*["']?13 4 1 \* \*["']?/.test(backupRenewal)
  ) {
    fail(
      'backup evidence renewal must keep the monthly schedule cron "13 4 1 * *"',
    );
  }
  if (!/workflow_dispatch:/.test(backupRenewal)) {
    fail("backup evidence renewal must keep workflow_dispatch");
  }

  const verifyStep = stepBlock(backupRenewal, "Verify Neon PITR history window");
  const recordStep = stepBlock(
    backupRenewal,
    "Record renewed backup evidence (+30 days)",
  );
  if (!verifyStep) {
    fail("backup evidence renewal must verify the Neon PITR history window");
  } else {
    if (!/history_retention_seconds/.test(verifyStep)) {
      fail("backup window verification must read history_retention_seconds");
    }
    if (!/EXPECTED_HISTORY_RETENTION_SECONDS/.test(verifyStep)) {
      fail(
        "backup window verification must compare the read window to the pinned expectation",
      );
    }
    if (!/exit 1/.test(verifyStep)) {
      fail("backup window verification must fail closed on a missing or mismatched window");
    }
    if (/continue-on-error:\s*true/.test(verifyStep)) {
      fail("backup window verification must not be allowed to continue on error");
    }
  }
  if (!recordStep) {
    fail("backup evidence renewal must record renewed backup evidence");
  } else {
    if (!/pnpm db:record-backup/.test(recordStep)) {
      fail("backup evidence renewal must record through db:record-backup");
    }
    if (
      /if:\s*always\(\)/.test(recordStep) ||
      /continue-on-error:\s*true/.test(recordStep)
    ) {
      fail("recording renewed evidence must not bypass a failed window verification");
    }
  }
  if (
    verifyStep &&
    recordStep &&
    backupRenewal.indexOf("Verify Neon PITR history window") >=
      backupRenewal.indexOf("Record renewed backup evidence")
  ) {
    fail("backup window verification must run before recording renewed evidence");
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Workflow triggers preserve the recovery scan and backup renewal contracts.");
}
