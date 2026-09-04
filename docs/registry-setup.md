# External registry setup checklist

These steps require the owner's authenticated browser session and cannot be completed safely by a code-only automation. Do not paste passwords, passkeys, recovery codes or registry tokens into issues, commits or chat.

## 1. Public GitHub home

The GitHub account `atalk` is already owned by an unrelated party. A clear available-looking alternative is `atalk-network`, but availability is only guaranteed when GitHub accepts the organization creation.

1. GitHub organization: `atalk-network` (created 2026-08-28).
2. Public repository: `https://github.com/atalk-network/atalk-developers` (created 2026-08-28).
3. The initial source export is maintained from the private product monorepo.
4. GitHub environments `npm` and `pypi` protect the release workflows and require owner approval.
5. Enable private vulnerability reporting under **Settings → Security → Code security and analysis**.
6. Protect `main` and the `node-v*` / `python-v*` release tag patterns.

Before any tag is pushed, package metadata and release checks must point to this exact public repository. The release workflows intentionally reject private publishing repositories.

## 2. npm ownership

1. npm account and two-factor authentication: confirmed 2026-08-28.
2. npm organization scope: `@atalk` (created 2026-08-28).
3. Package manifests use the confirmed `@atalk/*` names.
4. Coordinated alpha packages have been bootstrapped and their trusted publishers approved.

The coordinated Node release publishes these immutable packages:

- `@atalk/protocol`;
- `@atalk/core-native`;
- eight `@atalk/core-native-*` platform packages;
- `@atalk/sdk`;
- `@atalk/gateway`, `@atalk/openclaw`, `@atalk/mcp-server` and `@atalk/agent-plugin`.

The active trusted-publisher tuple is the public GitHub owner/repository, workflow
`release-node.yml` and environment `npm`. Keep publishing access behind 2FA and OIDC, with
traditional tokens disabled. Any bootstrap token must remain revoked and `NPM_TOKEN` must not be
restored.

Every newly introduced npm package, including `@atalk/gateway`, must be created by one approved release and then configured with the same Trusted Publisher tuple: `atalk-network/atalk-developers`, `release-node.yml`, environment `npm`.

## 3. PyPI ownership

1. PyPI account and two-factor authentication: confirmed 2026-08-28.
2. Trusted Publishers are active for the coordinated Python packages, including:
   - PyPI projects: `atalk-sdk` and `atalk-hermes`;
   - GitHub owner: the final public repository owner;
   - repository: `atalk-developers`;
   - workflow: `release-python.yml`;
   - environment: `pypi`.
3. Do not create a long-lived PyPI API token. Releases publish through OIDC from the protected
   `pypi` environment.

## 4. Legal and brand confirmation

Confirmed on 2026-08-28:

- copyright holder: Ariel Garbini;
- Apache-2.0 is approved for the public SDK, protocol and Rust developer surface;
- product brand: aTalk;
- intended GitHub organization: `atalk-network`.

The product application and backend remain proprietary.

Trademark clearance is a legal/business decision and is not replaced by checking GitHub, npm or PyPI name availability.

## 5. Release handoff

For every coordinated release, the maintainer must:

1. export the complete public subset listed in `public-ecosystem.md`;
2. update docs and package metadata together;
3. run clean-install, cross-platform CI and public-link checks;
4. push the public repository;
5. create the matching `node-v*` and `python-v*` tags only after that public commit is visible and
   the protected environments and registry trust are active.
