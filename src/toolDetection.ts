import { execFile } from 'child_process';
import * as path from 'path';

export interface ToolInfo {
  available: boolean;
  path: string;
  viaWsl: boolean;
}

const cache = new Map<string, ToolInfo>();

function tryExec(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

function tryExecShell(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, { shell: true, timeout: 5000 } as any, (error) => {
      resolve(!error);
    });
  });
}

export async function detectRsync(): Promise<ToolInfo> {
  const cached = cache.get('rsync');
  if (cached) { return cached; }

  // Try rsync directly (covers PATH, Git Bash, MSYS2)
  if (await tryExec('rsync', ['--version'])) {
    const info: ToolInfo = { available: true, path: 'rsync', viaWsl: false };
    cache.set('rsync', info);
    return info;
  }

  // On Windows, try Git's bundled rsync
  if (process.platform === 'win32') {
    const gitRsync = path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'rsync.exe');
    if (await tryExec(gitRsync, ['--version'])) {
      const info: ToolInfo = { available: true, path: gitRsync, viaWsl: false };
      cache.set('rsync', info);
      return info;
    }

    // Try WSL rsync
    if (await tryExecShell('wsl rsync --version')) {
      const info: ToolInfo = { available: true, path: 'wsl rsync', viaWsl: true };
      cache.set('rsync', info);
      return info;
    }
  }

  const info: ToolInfo = { available: false, path: '', viaWsl: false };
  cache.set('rsync', info);
  return info;
}

export async function detectSsh(): Promise<ToolInfo> {
  const cached = cache.get('ssh');
  if (cached) { return cached; }

  if (await tryExec('ssh', ['-V'])) {
    const info: ToolInfo = { available: true, path: 'ssh', viaWsl: false };
    cache.set('ssh', info);
    return info;
  }

  const info: ToolInfo = { available: false, path: '', viaWsl: false };
  cache.set('ssh', info);
  return info;
}

export async function detectScp(): Promise<ToolInfo> {
  const cached = cache.get('scp');
  if (cached) { return cached; }

  // scp doesn't have --version; just check it exists via help (exits non-zero but still resolves)
  const found = await new Promise<boolean>((resolve) => {
    execFile('scp', [], { timeout: 5000 }, (error) => {
      // scp with no args exits with error but still indicates it's present
      // If the error is ENOENT, it's not found
      resolve(!error || error.code !== 'ENOENT');
    });
  });

  if (found) {
    const info: ToolInfo = { available: true, path: 'scp', viaWsl: false };
    cache.set('scp', info);
    return info;
  }

  const info: ToolInfo = { available: false, path: '', viaWsl: false };
  cache.set('scp', info);
  return info;
}

export function clearToolCache(): void {
  cache.clear();
}
