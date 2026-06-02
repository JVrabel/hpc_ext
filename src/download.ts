import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
import type { HpcProfile } from './types';
import { buildSshTransport, buildRemoteAddress } from './sshUtils';
import { detectRsync, detectScp } from './toolDetection';

interface DownloadRequest {
  profile: HpcProfile;
  remotePath: string;
  isDirectory: boolean;
  localDestDir: string; // local *parent* folder; the remote basename is placed inside it
}

const SETUP_KEY_HINT =
  'Authentication failed. Use "HPC Sync: Setup SSH Key" or fix your SSH key, then try again.';

export class DownloadEngine {
  private process: ChildProcess | null = null;

  constructor(private output: vscode.OutputChannel) {}

  async download(req: DownloadRequest): Promise<void> {
    if (this.process) {
      vscode.window.showWarningMessage('A transfer is already in progress.');
      return;
    }

    const rsync = await detectRsync();
    const scp = await detectScp();
    if (!rsync.available && !scp.available) {
      vscode.window.showErrorMessage('Neither rsync nor scp is available.');
      return;
    }

    if (!fs.existsSync(req.localDestDir)) {
      vscode.window.showErrorMessage(`Local destination does not exist: ${req.localDestDir}`);
      return;
    }

    const remoteBase = basename(req.remotePath);
    const localTarget = path.join(req.localDestDir, remoteBase);

    if (fs.existsSync(localTarget)) {
      const choice = await vscode.window.showWarningMessage(
        `"${remoteBase}" already exists in ${req.localDestDir}. Overwrite / merge?`,
        { modal: true },
        'Overwrite',
      );
      if (choice !== 'Overwrite') {
        return;
      }
    }

    this.output.show(true);
    this.output.appendLine(`--- Download started: ${new Date().toLocaleTimeString()} ---`);
    this.output.appendLine(`Source: ${req.remotePath}`);
    this.output.appendLine(`Destination: ${req.localDestDir}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${remoteBase}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => this.cancel());
        try {
          if (rsync.available) {
            await this.downloadWithRsync(req, rsync, progress);
          } else {
            await this.downloadWithScp(req, progress);
          }
          this.output.appendLine('--- Download completed successfully ---');
          vscode.window.showInformationMessage(`Downloaded ${remoteBase} → ${req.localDestDir}`);
        } catch (err: any) {
          if (token.isCancellationRequested || err.cancelled) {
            this.output.appendLine('--- Download cancelled ---');
          } else {
            this.output.appendLine(`--- Download failed: ${err.message} ---`);
            const msg = isAuthError(err.message)
              ? `${err.message}\n\n${SETUP_KEY_HINT}`
              : `Download failed: ${err.message}`;
            vscode.window.showErrorMessage(msg);
          }
        } finally {
          this.process = null;
        }
      },
    );
  }

  cancel(): void {
    if (!this.process) { return; }
    if (process.platform === 'win32') {
      const pid = this.process.pid;
      if (pid) {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
      }
    } else {
      this.process.kill('SIGTERM');
    }
    this.process = null;
  }

  private downloadWithRsync(
    req: DownloadRequest,
    rsync: { path: string; viaWsl: boolean },
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transport = buildSshTransport(
        {
          sshHost: req.profile.sshHost,
          sshUser: req.profile.sshUser,
          sshPort: req.profile.sshPort,
          sshIdentityFile: req.profile.sshIdentityFile,
        },
        { batchMode: true },
      );

      // Use --progress (universal, works on macOS's bundled rsync 2.6.9).
      // --info=progress2 / --no-i-r / -h are 3.x-only and break on older rsync.
      const args: string[] = ['-az', '--progress', '-e', transport];

      // rsync source: for directories we transfer the dir itself (no trailing slash),
      // so the remote basename is placed inside the local dest dir.
      const remoteAddress = buildRemoteAddress({
        sshHost: req.profile.sshHost,
        sshUser: req.profile.sshUser,
      });
      const remoteSource = `${remoteAddress}:${shellQuoteForRsync(req.remotePath)}`;

      // Local destination is the *parent* folder (with trailing slash to keep semantics clear).
      let localDest = req.localDestDir.replace(/\\/g, '/');
      if (!localDest.endsWith('/')) { localDest += '/'; }

      args.push(remoteSource, localDest);

      this.output.appendLine(`> ${rsync.viaWsl ? 'wsl ' : ''}${rsync.path} ${args.join(' ')}`);

      const proc = rsync.viaWsl
        ? spawn('wsl', ['rsync', ...args], { shell: true })
        : spawn(rsync.path, args, { shell: false });

      this.process = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        for (const rawLine of text.split(/[\r\n]+/)) {
          const line = rawLine.trim();
          if (!line) { continue; }
          this.output.appendLine(line);
          // With --progress, rsync resets percent per-file, so we can't compute
          // a global increment. Just surface the latest line as a message — the
          // notification keeps a spinner, full detail goes to the output channel.
          if (/(\d{1,3})%/.test(line)) {
            progress.report({ message: line.replace(/\s+/g, ' ').slice(0, 80) });
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) { this.output.appendLine(`[stderr] ${line}`); }
        }
      });

      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          const err: any = new Error('cancelled');
          err.cancelled = true;
          reject(err);
        } else {
          reject(new Error(`rsync exited with code ${code}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }

  private downloadWithScp(
    req: DownloadRequest,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = [];
      if (req.isDirectory) { args.push('-r'); }
      if (req.profile.sshPort) { args.push('-P', String(req.profile.sshPort)); }
      if (req.profile.sshIdentityFile) { args.push('-i', req.profile.sshIdentityFile); }
      args.push('-o', 'StrictHostKeyChecking=accept-new');
      args.push('-o', 'BatchMode=yes');
      // -v gives us per-file progress lines; quieter than --progress and no flag is universally supported.

      const remoteAddress = buildRemoteAddress({
        sshHost: req.profile.sshHost,
        sshUser: req.profile.sshUser,
      });

      args.push(`${remoteAddress}:${shellQuoteForRsync(req.remotePath)}`);
      args.push(req.localDestDir);

      this.output.appendLine(`> scp ${args.join(' ')}`);
      progress.report({ message: 'scp (fallback) — no incremental progress' });

      const proc = spawn('scp', args, { shell: false });
      this.process = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) { this.output.appendLine(line); }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) { this.output.appendLine(`[stderr] ${line}`); }
        }
      });

      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          const err: any = new Error('cancelled');
          err.cancelled = true;
          reject(err);
        } else {
          reject(new Error(`scp exited with code ${code}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Single-quote a remote path so the remote shell receives it intact, while still letting rsync/scp's CLI parse it as one arg. */
function shellQuoteForRsync(p: string): string {
  // Outer is unquoted (the local shell isn't invoked here since shell:false),
  // but rsync/scp pass it to the remote shell verbatim — so quote for that shell.
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

function isAuthError(msg: string): boolean {
  return (
    /permission denied/i.test(msg) ||
    /authentication/i.test(msg) ||
    /publickey/i.test(msg) ||
    /no such identity/i.test(msg)
  );
}
