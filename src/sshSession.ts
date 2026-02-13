import * as vscode from 'vscode';
import {
  SshInfo,
  runSshCommand,
  createAskpassHelper,
  cleanupAskpass,
  escapeShellArg,
} from './sshUtils';

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

interface CacheEntry {
  entries: RemoteEntry[];
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;

export class SshSession {
  private askpassPath: string | undefined;
  private authenticated = false;
  private dirCache = new Map<string, CacheEntry>();

  constructor(private readonly info: SshInfo) {}

  async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) { return; }

    // Try key-based auth first
    try {
      await runSshCommand(this.info, 'echo ok');
      this.authenticated = true;
      return;
    } catch {
      // Key auth failed
    }

    // Prompt for password
    const host = this.info.sshUser
      ? `${this.info.sshUser}@${this.info.sshHost}`
      : this.info.sshHost;

    const password = await vscode.window.showInputBox({
      prompt: `Password for ${host}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      throw new Error('Authentication cancelled');
    }

    this.askpassPath = createAskpassHelper(password);

    try {
      await runSshCommand(this.info, 'echo ok', this.askpassPath);
      this.authenticated = true;
    } catch (err: any) {
      cleanupAskpass(this.askpassPath);
      this.askpassPath = undefined;
      throw new Error(`SSH authentication failed: ${err.message}`);
    }
  }

  async listDirectory(remotePath: string): Promise<RemoteEntry[]> {
    // Check cache
    const cached = this.dirCache.get(remotePath);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.entries;
    }

    await this.ensureAuthenticated();

    const cmd = `ls -la --time-style=+%s ${escapeShellArg(remotePath)} 2>/dev/null`;
    const raw = await runSshCommand(this.info, cmd, this.askpassPath);

    const entries: RemoteEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('total')) { continue; }

      // ls -la --time-style=+%s format:
      // drwxr-xr-x 2 user group 4096 1700000000 dirname
      const parts = trimmed.split(/\s+/);
      if (parts.length < 7) { continue; }

      const perms = parts[0];
      const size = parseInt(parts[4], 10) || 0;
      const mtime = parseInt(parts[5], 10) || 0;
      const name = parts.slice(6).join(' ');

      if (name === '.' || name === '..') { continue; }

      entries.push({
        name,
        isDirectory: perms.startsWith('d'),
        size,
        mtime,
      });
    }

    this.dirCache.set(remotePath, { entries, timestamp: Date.now() });
    return entries;
  }

  async readFile(remotePath: string): Promise<Uint8Array> {
    await this.ensureAuthenticated();

    const cmd = `base64 ${escapeShellArg(remotePath)}`;
    const raw = await runSshCommand(this.info, cmd, this.askpassPath, 60_000);

    const cleaned = raw.replace(/\s/g, '');
    return Buffer.from(cleaned, 'base64');
  }

  async writeFile(remotePath: string, content: Uint8Array): Promise<void> {
    await this.ensureAuthenticated();

    const b64 = Buffer.from(content).toString('base64');
    const cmd = `echo '${b64}' | base64 -d > ${escapeShellArg(remotePath)}`;
    await runSshCommand(this.info, cmd, this.askpassPath, 60_000);

    // Invalidate parent directory cache
    const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
    this.dirCache.delete(parent);
  }

  async stat(remotePath: string): Promise<{ isDirectory: boolean; size: number; mtime: number }> {
    await this.ensureAuthenticated();

    const cmd = `stat --format='%F %s %Y' ${escapeShellArg(remotePath)} 2>/dev/null || stat -f '%HT %z %m' ${escapeShellArg(remotePath)}`;
    const raw = await runSshCommand(this.info, cmd, this.askpassPath);
    const trimmed = raw.trim();

    // Linux: "directory 4096 1700000000" or "regular file 1234 1700000000"
    // macOS: "Directory 4096 1700000000" or "Regular File 1234 1700000000"
    const isDirectory = /^directory/i.test(trimmed);
    const nums = trimmed.match(/(\d+)\s+(\d+)$/);
    const size = nums ? parseInt(nums[1], 10) : 0;
    const mtime = nums ? parseInt(nums[2], 10) : 0;

    return { isDirectory, size, mtime };
  }

  clearCache(): void {
    this.dirCache.clear();
  }

  dispose(): void {
    cleanupAskpass(this.askpassPath);
    this.askpassPath = undefined;
    this.authenticated = false;
    this.dirCache.clear();
  }
}
