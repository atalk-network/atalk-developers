import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { atalkPlugin } from "./channel.js";
import { setAtalkRuntime } from "./runtime.js";

const entry = defineChannelPluginEntry({
  id: "atalk",
  name: "aTalk",
  description: "Native end-to-end encrypted aTalk messaging channel",
  plugin: atalkPlugin,
  setRuntime: setAtalkRuntime,
});

// Keep the generated public declaration independent from OpenClaw's hashed
// internal declaration modules while preserving the full runtime value.
export default entry as {
  id: string;
  name: string;
  description: string;
  register(api: unknown): void;
};
