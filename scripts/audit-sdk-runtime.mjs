import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const TRANSIENT_NPM_FAILURE =
  /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket (?:hang up|timeout)|network timeout|fetch failed|network request failed|audit endpoint returned an error|(?:http|status(?: code)?)\s*(?:429|500|502|503|504)\b|\b(?:429 too many requests|50[0234] (?:bad gateway|service unavailable|gateway timeout|internal server error))\b/i;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function hasCompletedAuditReport(stdout) {
  try {
    const report = JSON.parse(stdout.trim());
    const vulnerabilities = report?.metadata?.vulnerabilities;
    return (
      report?.auditReportVersion != null &&
      vulnerabilities != null &&
      typeof vulnerabilities === "object" &&
      Number.isFinite(vulnerabilities.total)
    );
  } catch {
    return false;
  }
}

export function isTransientNpmFailure(result) {
  const output = [result.error?.code, result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n");
  return TRANSIENT_NPM_FAILURE.test(output);
}

function commandFailure(args, result, transientUnavailable = false) {
  const detail = result.signal
    ? `terminated by ${result.signal}`
    : `exited with code ${result.status ?? 1}`;
  const error = new Error(`npm ${args.join(" ")} ${detail}`);
  error.exitCode = result.status ?? 1;
  error.transientUnavailable = transientUnavailable;
  return error;
}

export async function runNpmWithRetry(args, options = {}) {
  const {
    cwd,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    execute = (commandArgs) =>
      spawnSync("npm", commandArgs, {
        cwd,
        encoding: "utf8",
        timeout: commandTimeoutMs,
      }),
    wait = sleep,
    writeStdout = (value) => process.stdout.write(value),
    writeStderr = (value) => process.stderr.write(value),
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = execute(args);
    if (result.stdout) writeStdout(result.stdout);
    if (result.stderr) writeStderr(result.stderr);

    if (result.status === 0 && !result.error && !result.signal) return;

    // A completed audit report is authoritative. In particular, never retry or
    // hide a non-zero result caused by vulnerabilities at the configured level.
    const completedAudit = args[0] === "audit" && hasCompletedAuditReport(result.stdout ?? "");
    const retryable = !completedAudit && isTransientNpmFailure(result);

    if (!retryable || attempt === maxAttempts) {
      throw commandFailure(args, result, retryable);
    }

    const delay = retryDelayMs * 2 ** (attempt - 1);
    writeStderr(
      `[audit:sdk] npm ${args[0]} failed transiently; retrying in ${delay}ms ` +
        `(${attempt + 1}/${maxAttempts})\n`,
    );
    await wait(delay);
  }
}

export async function main() {
  const protocol = JSON.parse(await readFile("core/protocol/package.json", "utf8"));
  const sdk = JSON.parse(await readFile("sdk/node/package.json", "utf8"));
  const gateway = JSON.parse(await readFile("integrations/gateway/package.json", "utf8"));
  const mcp = JSON.parse(await readFile("integrations/mcp/package.json", "utf8"));
  const dependencies = { ...protocol.dependencies };

  for (const manifest of [sdk, gateway, mcp]) {
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!name.startsWith("@atalk/")) dependencies[name] = version;
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "atalk-sdk-audit-"));
  const maxAttempts = positiveIntegerEnvironment("ATALK_AUDIT_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
  const commandTimeoutMs = positiveIntegerEnvironment("ATALK_AUDIT_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS);
  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    );
    await runNpmWithRetry(
      ["install", "--package-lock-only", "--ignore-scripts", "--no-fund", "--no-audit"],
      { cwd: directory, maxAttempts, commandTimeoutMs },
    );
    await runNpmWithRetry(["audit", "--omit=dev", "--audit-level=high", "--json"], {
      cwd: directory,
      maxAttempts,
      commandTimeoutMs,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function positiveIntegerEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    if (error?.transientUnavailable && process.env.ATALK_AUDIT_ALLOW_UNAVAILABLE === "1") {
      const prefix = process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "[audit:sdk] ";
      process.stderr.write(`${prefix}npm advisory service unavailable; dependency audit deferred.\n`);
    } else {
      throw error;
    }
  }
}
