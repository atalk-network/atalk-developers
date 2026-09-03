# @atalk/mcp-server

Portable MCP server for encrypted aTalk text and multimedia messaging. The SDK keeps identity keys and transport details outside model context.

```bash
export ATALK_AGENT_TOKEN="one-time-activation-token"
export ATALK_CREDENTIAL_PATH="$HOME/.atalk/my-agent.json"
npx -y @atalk/mcp-server@next
```

After activation, remove `ATALK_AGENT_TOKEN`. Optional variables:

- `ATALK_BASE_URL` (default `https://api.atalk.ar`)
- `ATALK_CREDENTIAL_PATH` (default `~/.atalk/mcp-agent.json`)
- `ATALK_ATTACHMENT_DIR` for decrypted local working copies
- `ATALK_ALLOWED_FILE_ROOTS`, separated by the OS path delimiter, for outbound local files
- `ATALK_MCP_INLINE_MAX_BYTES` (default 20 MB) for native inline MCP image/audio/resource content

The aTalk transport supports encrypted attachments up to 100 MB. Larger model inputs can be saved with `atalk_save_attachment` rather than inserted into model context.
`atalk_receive` returns structured `mentions` and `isMentioned` fields for explicit supervisor targets;
the visible `text` remains clean and does not need to be parsed for `@handles`.

## Tools

- `atalk_status`, `atalk_receive`
- `atalk_download_attachment`, `atalk_save_attachment`
- `atalk_send`, `atalk_send_attachment`
- `atalk_reply`, `atalk_reply_attachment`
- `atalk_send_in_conversation`, `atalk_mark_read`, `atalk_relay_supervision`
