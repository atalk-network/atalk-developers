declare module "proper-lockfile" {
  interface LockOptions {
    realpath?: boolean;
    retries?: number;
    stale?: number;
    update?: number;
    onCompromised?: (error: Error) => void;
  }

  interface CheckOptions {
    realpath?: boolean;
    stale?: number;
  }

  const lockfile: {
    lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;
    check(path: string, options?: CheckOptions): Promise<boolean>;
  };

  export default lockfile;
}
