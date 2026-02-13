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

    if (!profile.remoteProjectDir || profile.remoteProjectDir === '/') {
      vscode.window.showErrorMessage('Remote project directory is not set. Edit the profile and select a remote directory first.');
      return;
    }

    const rsync = await detectRsync();
    const scp = await detectScp();

    if (!rsync.available && !scp.available) {
      vscode.window.showErrorMessage('Neither rsync nor scp found. Please install rsync or ensure scp is available.');
      this.statusBar.setState(SyncState.Error);
      return;
    }

    // Confirm before destructive delete
    if (profile.deleteOnSync && !dryRun) {
      const answer = await vscode.window.showWarningMessage(
        `Delete is enabled: files on the remote not present locally will be REMOVED from "${profile.remoteProjectDir}". This is not version-controlled and may be irreversible. Continue?`,
        { modal: true },
        'Yes, delete remote-only files',
      );
      if (answer !== 'Yes, delete remote-only files') {
        return;
      }
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
        if (profile.deleteOnSync) {
          await this.cleanRemoteDir(profile);
        }
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
    parts.push('-o ServerAliveInterval=60');
    parts.push('-o ServerAliveCountMax=60');
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
      args.push('-o', 'ServerAliveInterval=60');
      args.push('-o', 'ServerAliveCountMax=60');

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

  private cleanRemoteDir(profile: HpcProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      const remoteDir = profile.remoteProjectDir;
      // Remove all contents inside the remote dir (files + hidden files), but keep the dir itself
      const cmd = `find ${escapeShellArg(remoteDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`;

      const sshArgs: string[] = [];
      if (profile.sshPort) { sshArgs.push('-p', String(profile.sshPort)); }
      if (profile.sshIdentityFile) { sshArgs.push('-i', profile.sshIdentityFile); }
      sshArgs.push('-o', 'StrictHostKeyChecking=accept-new');

      const host = profile.sshUser ? `${profile.sshUser}@${profile.sshHost}` : profile.sshHost;
      sshArgs.push(host, cmd);

      this.output.appendLine(`> ssh ${host} "${cmd}"`);

      const proc = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) { this.output.appendLine(`[stderr] ${line}`); }
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.output.appendLine('Remote directory cleaned.');
          resolve();
        } else {
          reject(new Error(`Failed to clean remote directory (exit code ${code})`));
        }
      });

      proc.on('error', (err) => reject(err));
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

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
