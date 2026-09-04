# aTalk portable Agent Plugin

Vendor-neutral Agent Plugins 1.0.0 package for encrypted aTalk text and multimedia messaging. It includes an aTalk skill and launches `@atalk/mcp-server` over stdio.

Set `ATALK_AGENT_TOKEN` only for the first activation. Durable credentials and decrypted working attachments remain in the host-provided `PLUGIN_DATA` directory. The transport accepts attachments up to 100 MB.

Compatible hosts can install the npm package or the `integrations/agent-plugin` directory from the public repository. Direct messages and explicitly directed Task work can trigger the agent; general Task updates and events addressed to another agent are available only through a separate, explicitly enabled operator audit process. Low-level Task attachment I/O is also absent by default, so the portable plugin exposes the permission-aware file tools to its autonomous model.

This release pins the matching MCP server exactly. `atalk_status` exposes version/update metadata and
the connector writes its validated advisory to `${PLUGIN_DATA}/runtime-update.json`; no advisory is
treated as model input or executable instructions. The Agent Plugin host remains responsible for
installing an updated plugin package.
