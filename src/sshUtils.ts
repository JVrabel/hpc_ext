import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export interface SshInfo {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshIdentityFile?: string;
}

export function buildSshArgs(info: SshInfo): string[] {
  const args: string[] = [];

  if (info.sshPort) {
    args.push('-p', String(info.sshPort));
  }
  if (info.sshIdentityFile) {
    args.push('-i', info.sshIdentityFile);
  }
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'ServerAliveInterval=60');
  args.push('-o', 'ServerAliveCountMax=60');

  const host = info.sshUser ? `${info.sshUser}@${info.sshHost}` : info.sshHost;
  args.push(host);

  return args;
}

/** Create a temporary askpass helper that echoes the password. */
export function createAskpassHelper(password: string): string {
  const encoded = Buffer.from(password).toString('base64');
  const nodeExe = process.execPath;
  const id = `hpc-askpass-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (process.platform === 'win32') {
    const filePath = path.join(os.tmpdir(), `${id}.cmd`);
    fs.writeFileSync(filePath, `@echo off\r\n"${nodeExe}" -e "process.stdout.write(Buffer.from('${encoded}','base64').toString())"\r\n`);
    return filePath;
  } else {
    const filePath = path.join(os.tmpdir(), `${id}.sh`);
    fs.writeFileSync(filePath, `#!/bin/sh\n"${nodeExe}" -e "process.stdout.write(Buffer.from('${encoded}','base64').toString())"\n`, { mode: 0o700 });
    return filePath;
  }
}

export function cleanupAskpass(askpassPath: string | undefined): void {
  if (askpassPath) {
    try { fs.unlinkSync(askpassPath); } catch { /* ignore */ }
  }
}

export function runSshCommand(
  info: SshInfo,
  command: string,
  askpassPath?: string,
  timeoutMs: number = 15000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...buildSshArgs(info), command];

    const env: Record<string, string | undefined> = { ...process.env };
    if (askpassPath) {
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = ':0';
    } else {
      // Key-only, no password prompts
      args.splice(args.length - 2, 0, '-o', 'BatchMode=yes');
    }

    const proc = spawn('ssh', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `SSH exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

export function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
