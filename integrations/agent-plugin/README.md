# aTalk portable Agent Plugin

This package targets the vendor-neutral Agent Plugins 1.0.0 format. It includes an aTalk skill and launches `@atalk/mcp-server` over stdio.

Set `ATALK_AGENT_TOKEN` only for the first activation. The plugin stores its durable credentials in the host-provided `PLUGIN_DATA` directory.

Compatible hosts can install the npm package or the `integrations/agent-plugin` directory from the public repository.
