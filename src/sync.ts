import * as vscode from 'vscode';
import { spawn, ChildProcess, execFile } from 'child_process';
import type { HpcProfile } from './types';
import { SyncState } from './types';
import { StatusBarManager } from './statusBar';
import { detectRsync, detectScp } from './toolDetection';

export class SyncEngine {
  private process: ChildProcess | null = null;

  constructor(
    private output: vscode.OutputChannel,
    private statusBar: StatusBarManager,
  ) {}

  async push(profile: HpcProfile, dryRun = false): Promise<void> {
    if (this.process) {
      vscode.window.showWarningMessage('A sync is already in progress. Cancel it first.');
      return;
    }

    const rsync = await detectRsync();
    const scp = await detectScp();

    if (!rsync.available && !scp.available) {
      vscode.window.showErrorMessage('Neither rsync nor scp found. Please install rsync or ensure scp is available.');
      this.statusBar.setState(SyncState.Error);
      return;
    }

    this.statusBar.setState(SyncState.Syncing, profile.name);
    this.output.show(true);
    this.output.appendLine(`--- Sync started: ${new Date().toLocaleTimeString()} ---`);
    this.output.appendLine(`Profile: ${profile.name}`);
    this.output.appendLine(`Direction: push${dryRun ? ' (dry run)' : ''}`);

    try {
      if (rsync.available) {
        await this.pushWithRsync(profile, rsync, dryRun);
      } else {
        if (dryRun) {
          vscode.window.showWarningMessage('Dry run is not supported with scp fallback.');
          this.statusBar.setState(SyncState.Idle, profile.name);
          return;
        }
        vscode.window.showWarningMessage('rsync not found, using scp (full copy, not incremental). Exclude patterns will be ignored.');
        await this.pushWithScp(profile);
      }

      if (this.process) {
        this.output.appendLine('--- Sync completed successfully ---');
        this.statusBar.setState(SyncState.Synced, profile.name);
      }
    } catch (err: any) {
      if (err.killed) {
        this.output.appendLine('--- Sync cancelled ---');
        this.statusBar.setState(SyncState.Idle, profile.name);
      } else {
        this.output.appendLine(`--- Sync failed: ${err.message} ---`);
        this.statusBar.setState(SyncState.Error);
        vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
      }
    } finally {
      this.process = null;
    }
  }

  cancel(): void {
    if (!this.process) {
      vscode.window.showInformationMessage('No sync in progress.');
      return;
    }

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

  private buildSshArg(profile: HpcProfile): string {
    const parts = ['ssh'];
    if (profile.sshPort) {
      parts.push(`-p ${profile.sshPort}`);
    }
    if (profile.sshIdentityFile) {
      parts.push(`-i "${profile.sshIdentityFile}"`);
    }
    parts.push('-o StrictHostKeyChecking=accept-new');
    return parts.join(' ');
  }

  private buildRemoteTarget(profile: HpcProfile): string {
    const userPart = profile.sshUser ? `${profile.sshUser}@` : '';
    return `${userPart}${profile.sshHost}:${profile.remoteProjectDir}/`;
  }

  private pushWithRsync(profile: HpcProfile, rsync: { path: string; viaWsl: boolean }, dryRun: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-avz', '--progress'];

      if (dryRun) {
        args.push('--dry-run');
      }
      if (profile.deleteOnSync) {
        args.push('--delete');
      }
      for (const pattern of profile.excludePatterns) {
        args.push(`--exclude=${pattern}`);
      }

      args.push('-e', this.buildSshArg(profile));

      let localDir = profile.localProjectDir.replace(/\\/g, '/');
      if (!localDir.endsWith('/')) { localDir += '/'; }

      if (rsync.viaWsl) {
        // Convert Windows path to WSL path
        const wslArgs = ['rsync', ...args, `$(wslpath -u '${profile.localProjectDir}')` + '/', this.buildRemoteTarget(profile)];
        this.output.appendLine(`> wsl ${wslArgs.join(' ')}`);

        const proc = spawn('wsl', wslArgs, { shell: true });
        this.process = proc;
        this.pipeOutput(proc, resolve, reject);
      } else {
        args.push(localDir, this.buildRemoteTarget(profile));
        this.output.appendLine(`> ${rsync.path} ${args.join(' ')}`);

        const proc = spawn(rsync.path, args, { shell: true });
        this.process = proc;
        this.pipeOutput(proc, resolve, reject);
      }
    });
  }

  private pushWithScp(profile: HpcProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-r'];

      if (profile.sshPort) {
        args.push('-P', String(profile.sshPort));
      }
      if (profile.sshIdentityFile) {
        args.push('-i', profile.sshIdentityFile);
      }
      args.push('-o', 'StrictHostKeyChecking=accept-new');

      let localDir = profile.localProjectDir.replace(/\\/g, '/');
      if (localDir.endsWith('/')) { localDir = localDir.slice(0, -1); }
      args.push(localDir + '/*');

      args.push(this.buildRemoteTarget(profile));
      this.output.appendLine(`> scp ${args.join(' ')}`);

      const proc = spawn('scp', args, { shell: true });
      this.process = proc;
      this.pipeOutput(proc, resolve, reject);
    });
  }

  private pipeOutput(proc: ChildProcess, resolve: () => void, reject: (err: any) => void): void {
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.output.appendLine(line);
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.output.appendLine(`[stderr] ${line}`);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  }
}
