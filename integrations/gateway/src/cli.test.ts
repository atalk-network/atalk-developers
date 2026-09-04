import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOptions, shutdownGatewayWithDeadline } from "./cli.js";

describe("gateway CLI parsing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("fails closed on unknown, duplicate, or misplaced options", () => {
    expect(() => parseOptions(["manager", "update", "--dryrun"])).toThrow("Unknown option");
    expect(() => parseOptions(["manager", "update", "--policy", "NOTIFY", "--policy", "COMPATIBLE"]))
      .toThrow("Duplicate option");
    expect(() => parseOptions(["start", "--dry-run"])).toThrow("only valid for manager update");
    expect(() => parseOptions(["self-test", "unexpected"])).toThrow("Unknown option or argument");
  });

  it("accepts the explicit manager update dry-run form", () => {
    expect(parseOptions(["manager", "update", "--dry-run", "--policy", "NOTIFY"]))
      .toMatchObject({ command: "manager-update", dryRun: true, managerPolicy: "NOTIFY" });
  });

  it("rejects partial integers and ignores manager-only environment for ordinary commands", () => {
    vi.stubEnv("ATALK_UPDATE_POLICY", "BROKEN");
    vi.stubEnv("ATALK_UPDATE_POLL_SECONDS", "60junk");
    vi.stubEnv("ATALK_GATEWAY_PORT", "bad-port");
    expect(parseOptions(["self-test"])).toMatchObject({ command: "self-test", port: 8788 });
    expect(parseOptions(["start", "--port", "8788"])).toMatchObject({ command: "start", port: 8788 });
    expect(() => parseOptions(["start", "--port", "8788junk"])).toThrow("Gateway port");
    vi.stubEnv("ATALK_GATEWAY_PORT", "8788");
    expect(() => parseOptions(["manager", "status"])).toThrow("Runtime Manager policy");
  });

  it("forces a non-zero exit when managed child shutdown hangs", async () => {
    vi.useFakeTimers();
    let releaseStop!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { releaseStop = resolve; }));
    const exit = vi.fn();
    const shutdown = shutdownGatewayWithDeadline(stop, 1, exit, 50);

    await vi.advanceTimersByTimeAsync(50);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    releaseStop();
    await shutdown;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
