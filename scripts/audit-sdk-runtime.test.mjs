import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCompletedAuditReport,
  isTransientNpmFailure,
  runNpmWithRetry,
} from "./audit-sdk-runtime.mjs";

const vulnerabilityReport = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: { example: { severity: "high" } },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  },
});

test("recognizes completed audit reports and transient npm failures", () => {
  assert.equal(hasCompletedAuditReport(vulnerabilityReport), true);
  assert.equal(hasCompletedAuditReport('{"error":{"code":"ETIMEDOUT"}}'), false);
  assert.equal(
    isTransientNpmFailure({ status: 1, stdout: "", stderr: "npm error code ETIMEDOUT" }),
    true,
  );
  assert.equal(
    isTransientNpmFailure({ status: 1, stdout: vulnerabilityReport, stderr: "" }),
    false,
  );
});

test("retries a transient registry failure with exponential backoff", async () => {
  const results = [
    { status: 1, stdout: "", stderr: "npm error code ECONNRESET\n" },
    { status: 0, stdout: "audit ok\n", stderr: "" },
  ];
  const delays = [];
  let calls = 0;

  await runNpmWithRetry(["audit"], {
    maxAttempts: 3,
    retryDelayMs: 25,
    execute: () => results[calls++],
    wait: async (delay) => delays.push(delay),
    writeStdout: () => {},
    writeStderr: () => {},
  });

  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
});

test("fails immediately for a completed vulnerability report", async () => {
  let calls = 0;

  await assert.rejects(
    runNpmWithRetry(["audit", "--audit-level=high", "--json"], {
      maxAttempts: 3,
      execute: () => {
        calls += 1;
        return { status: 1, stdout: vulnerabilityReport, stderr: "" };
      },
      wait: async () => assert.fail("a vulnerability report must not be retried"),
      writeStdout: () => {},
      writeStderr: () => {},
    }),
    /exited with code 1/,
  );

  assert.equal(calls, 1);
});

test("fails closed after bounded transient retries", async () => {
  let calls = 0;

  await assert.rejects(
    runNpmWithRetry(["audit"], {
      maxAttempts: 3,
      retryDelayMs: 1,
      execute: () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: "npm error code EAI_AGAIN\n" };
      },
      wait: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    }),
    /exited with code 1/,
  );

  assert.equal(calls, 3);
});
