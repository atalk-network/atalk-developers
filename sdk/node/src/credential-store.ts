import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IdentityKeyPair, PublicPeer } from "@atalk/protocol";

export interface AgentCredentials {
  /** Legacy access-token field. Kept required for stored credential compatibility. */
  sessionToken: string;
  /** Canonical access token for refresh-capable credential issuers. */
  accessToken?: string;
  refreshToken?: string;
  /** In-flight refresh operation, persisted before the network request for safe replay. */
  refreshRequestId?: string;
  accessTokenExpiresAt?: string;
  peer: PublicPeer;
  keys: IdentityKeyPair;
}

export interface RefreshedAgentCredentials {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
}

export interface CredentialRefreshContext {
  credentials: Readonly<AgentCredentials>;
  reason: "EXPIRING" | "UNAUTHORIZED";
  baseUrl: string;
}

export type CredentialRefresher = (
  context: CredentialRefreshContext,
) => Promise<RefreshedAgentCredentials | undefined>;

export interface CredentialStore {
  load(): Promise<AgentCredentials | undefined>;
  save(credentials: AgentCredentials): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(activationToken?: string, path?: string) {
    if (path) {
      this.path = resolve(path);
      return;
    }
    if (!activationToken) {
      throw new Error("An activation token or an explicit credential path is required");
    }
    const suffix = createHash("sha256").update(activationToken).digest("hex").slice(0, 16);
    this.path = resolve(`.atalk/agent-${suffix}.json`);
  }

  async load(): Promise<AgentCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as AgentCredentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}
