# Contributing to the aTalk developer ecosystem

This repository accepts contributions to the aTalk protocol, portable Rust core, native Node binding and Node/Python SDKs. The hosted service and product applications are developed separately.

## Before opening a change

Use a GitHub issue or discussion for substantial protocol or public API changes. Security reports must follow `SECURITY.md` and must not be discussed publicly before remediation.

## Development setup

```bash
corepack enable
pnpm install --frozen-lockfile
python -m venv sdk/python/.venv
sdk/python/.venv/bin/python -m pip install -e 'sdk/python[test]'
```

Run the public ecosystem checks:

```bash
pnpm build:native:node
pnpm typecheck
pnpm test
pnpm audit:sdk
pnpm smoke:sdk:node
sdk/python/.venv/bin/python -m pytest sdk/python/tests
```

Before submitting a pull request:

- add or update tests for behavior changes;
- preserve compatibility across TypeScript, Rust and Python golden vectors;
- update package documentation and `CHANGELOG.md` for public API changes;
- never commit tokens, private keys, `.env` files, credentials or generated native binaries;
- keep commits focused and explain compatibility or security trade-offs.

Contributions to Apache-2.0-licensed directories are submitted under that same license, as described in Section 5 of the license.
