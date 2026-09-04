import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { atalkPlugin } from "./channel.js";
import { setAtalkRuntime } from "./runtime.js";
import { registerAtalkTaskTools } from "./tools.js";

interface PortableChannelEntry {
  id?: string;
  name?: string;
  description?: string;
  register?: (api: unknown) => void;
}

const entry = defineChannelPluginEntry({
  id: "atalk",
  name: "aTalk",
  description: "Native end-to-end encrypted aTalk text and multimedia channel",
  plugin: atalkPlugin,
  setRuntime: setAtalkRuntime,
  registerFull: registerAtalkTaskTools,
}) as unknown as PortableChannelEntry;

export default entry;
