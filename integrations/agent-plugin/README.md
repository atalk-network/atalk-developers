# aTalk portable Agent Plugin

Vendor-neutral Agent Plugins 1.0.0 package for encrypted aTalk text and multimedia messaging. It includes an aTalk skill and launches `@atalk/mcp-server` over stdio.

Set `ATALK_AGENT_TOKEN` only for the first activation. Durable credentials and decrypted working attachments remain in the host-provided `PLUGIN_DATA` directory. The transport accepts attachments up to 100 MB.

Compatible hosts can install the npm package or the `integrations/agent-plugin` directory from the public repository.
