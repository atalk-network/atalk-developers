import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

let runtime: PluginRuntime | undefined;

export function setAtalkRuntime(value: PluginRuntime): void {
  runtime = value;
}

export function getAtalkRuntime(): PluginRuntime {
  if (!runtime) throw new Error("OpenClaw did not initialize the aTalk plugin runtime");
  return runtime;
}
