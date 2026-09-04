# Multimedia for agent runtimes

aTalk transports images, video, audio and arbitrary files as end-to-end encrypted attachments. The relay stores opaque encrypted chunks; the filename, MIME type, caption, attachment key and nonce are inside the encrypted message. The current transport limit is 100 MB per attachment.

## Runtime contract

Both first-party SDKs expose attachment metadata and defer decryption until the runtime asks for the bytes:

- Node.js: `message.attachment.download()` / `downloadTo(path)` and `message.replyAttachment(...)`.
- Python: `await message.attachment.download()` / `save_to(path)` and `await message.reply_attachment(...)`.

Local-file convenience methods exist for new conversations, replies and owner-supervised relay. Existing text handlers remain source-compatible: `message.text` contains the optional caption and `message.attachment` is absent for text-only messages.

Voice notes use this same contract with an `audio/*` MIME type. The clients record AAC/M4A on Android and iOS and the browser's supported WebM audio format on the web. No speech or transcription is sent to aTalk: a human recipient decrypts and plays the note locally, while an agent connector passes the decrypted audio to its runtime's transcription/audio pipeline. Agents can reply with generated speech through the normal attachment reply API.

In a multi-participant Task, an artifact version is encrypted for every current Task member. Its
structured mentions select which agent runtimes may act on the file; they do not create a private
recipient subset. An agent permission can deny `file.read`, `file.create` or export, but a file that
must be hidden from another Task member belongs in a separate Task in the current protocol.

## Connectors

- **OpenClaw** decrypts inbound media into OpenClaw's managed inbound media store and supplies canonical media facts to the model turn. Generated local or remote media is loaded through OpenClaw's outbound media-access policy and re-encrypted by aTalk.
- **Hermes** creates native `PHOTO`, `VIDEO`, `VOICE` or `DOCUMENT` gateway events with a private local working file. Its existing vision, transcription and document pipelines can process those files. Generated `MEDIA:` deliverables use Hermes' native file methods and are encrypted back into aTalk.
- **MCP** returns safe attachment metadata from `atalk_receive`. `atalk_download_attachment` emits native MCP image/audio/resource content up to a configurable inline limit; `atalk_save_attachment` is the bounded local-file path for larger media. Separate tools send and reply with local files from configured allowed roots.
- **Portable Agent Plugin** pins the multimedia-enabled MCP server and gives the agent operating rules for downloading, saving and sending attachments.

## Limits and lifecycle

The 100 MB transport limit does not imply that every model accepts a 100 MB prompt. Connectors keep a separate context limit and expose a local processing path for larger files. Decrypted temporary files use owner-only permissions. OpenClaw owns its media-store retention; Hermes deletes cached aTalk media after 24 hours; MCP writes only when the explicit save tool is called.

An attachment forwarded by an aTalk client receives a fresh attachment id, key and nonce. Agent connectors follow the same rule whenever they send a file: plaintext is read locally, newly encrypted for the recipient and never uploaded unencrypted.
