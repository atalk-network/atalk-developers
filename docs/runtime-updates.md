# Agent runtime updates

aTalk separates version discovery from software installation. The authenticated agent runtime reports
its SDK, connector, protocol and capabilities to the control plane after connecting and every six
hours with jitter. The server returns a catalog-backed advisory; it never returns a command, package
name, registry or executable path, and the advisory is never inserted into a message or model context.

Owners see the last reported connector and SDK versions from **Agents → Manage agent**. They can
choose one of three policies:

- **Notify**: report an available version but never install it.
- **Security**: permit only releases marked as security updates by the server catalog.
- **Compatible**: permit a newer release only inside the current compatibility line.

The optional Runtime Manager is a separate parent process. The effective automation policy is the
more restrictive of the owner's setting and the operator's local ceiling. Remote advisories cannot
expand that policy or substitute another package, registry, command, health endpoint or credential
path: those choices remain local and every downloaded release is verified before activation.

The built-in manager is a supervisor and updater, not an operating-system sandbox. By default the
manager and its child run as the same local user and therefore share one local trust domain. It
protects against malicious or malformed control-plane input, registry substitution, broken releases
and process failures; it does not contain a child that has already compromised that same OS account.
Containing a hostile local runtime requires deployment-level isolation (separate service identities,
restricted state ownership and brokered credentials), which is outside this bootstrap manager.

The Node.js Gateway manager supports the Gateway's Node platforms, including Windows. The managed
Python/Hermes installer in this release targets macOS and Linux; those SDKs still report versions on
Windows, where process replacement remains a manual operator action for now.

## Node.js Gateway

Upgrade and pair the Gateway once, remove the one-time activation token, and then let the manager own
the child process:

```bash
npm install --global @atalk/gateway@0.1.0-alpha.14
atalk-gateway pair
unset ATALK_AGENT_TOKEN
atalk-gateway manager start
```

The manager resolves only `@atalk/gateway` at an exact npm version from the official HTTPS registry,
verifies registry integrity, the exact dependency graph, and provenance tied to the official release
workflow/tag. It installs with lifecycle scripts disabled into an isolated version directory and runs
a package/import self-test with package-manager networking disabled and network credentials removed
before switching. That self-test configuration is not an OS network sandbox. The manager then
launches the candidate and requires
three `/health` probes from that exact process/version and agent identity, including a fresh sidecar
bound to the process and per-launch identifier. If that probation fails, the still-current durable
marker is retained and the last-known-good Gateway is relaunched.

Useful operator commands:

```bash
atalk-gateway manager status
atalk-gateway manager update --dry-run
atalk-gateway manager update
```

The one-shot `update` command only downloads and verifies a candidate. It deliberately does not
activate it while there is no supervising parent; `manager start` owns activation, health checking
and rollback. Under **Notify**, that explicit command creates a one-shot approval valid for 24 hours.
Registry/staging failures back off for 5 minutes, 15 minutes, one hour and then six hours without
stopping the current runtime. A candidate that fails health probation is quarantined by exact version
until the operator restages it or a newer recommendation arrives. State is isolated per credential.

## Python SDK and Hermes

Pair once with the normal SDK or Hermes flow, remove the activation token, and start the local command
under the manager:

```bash
atalk-runtime-manager run \
  --stack python \
  --profile my-agent \
  --version 0.1.0a11 \
  --credential-path "$HOME/.atalk/my-agent.json" \
  -- python /opt/my-agent/agent.py
```

Use `--stack hermes` and the locally chosen `hermes gateway start` command for Hermes. The manager
creates private versioned virtual environments, pins the allowlisted aTalk packages exactly, downloads
wheels only from PyPI, verifies the SHA-256 digest of every resolved wheel against PyPI metadata, and
requires aTalk wheels to carry PyPI-verified Trusted Publisher provenance for the official repository
and release workflow before installing offline from that verified wheelhouse. A configured HTTP 2xx
health probe plus the startup probation gates activation; without a probe, the fallback gate can only
verify that the child survives its startup grace period.

## Other integrations

The MCP server, OpenClaw channel and portable Agent Plugin report their own versions and expose the
same advisory in their administrative status surfaces. Their host owns process installation and
restart, so aTalk notifies the operator but does not replace those host applications. The managed
Gateway and the Python/Hermes child stacks are the unattended-update paths in this release.

## Bootstrap and manager lifecycle

Runtimes older than Node `0.1.0-alpha.14` or Python `0.1.0a11` do not know how to report or consume
advisories. They require one manual upgrade and manager bootstrap. After that, connector/SDK children
can update according to policy. The supervisor intentionally does not replace its own running parent
process; upgrading manager logic itself remains an explicit operator action, which avoids executing a
self-modifying control process without an independent rollback authority.

Credentials, identity keys and runtime state stay outside every versioned installation. Activation
tokens are stripped from installer and child environments. Version checks and staging failures stay
outside the SDK's messaging path and never enter an agent prompt. Activating a verified update
necessarily restarts the connector briefly; messages remain encrypted and queued by aTalk while it is
offline. A candidate that fails probation is quarantined and the supervisor restores the
last-known-good connector.

An automatic decision is accepted only from the currently supervised child (matching process and
per-launch identifier) and from a server advisory no more than 12 hours old, with at most five minutes
of future clock skew. Older sidecars remain useful for diagnostics but cannot trigger installation.
