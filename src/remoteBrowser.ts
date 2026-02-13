import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

interface SshInfo {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshIdentityFile?: string;
}

function buildSshArgs(info: SshInfo): string[] {
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
function createAskpassHelper(password: string): string {
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

function runSshCommand(info: SshInfo, command: string, askpassPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...buildSshArgs(info), command];

    const env: Record<string, string | undefined> = { ...process.env };
    if (askpassPath) {
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = ':0';
    } else {
      // First attempt: key-only, no password prompts
      args.splice(args.length - 2, 0, '-o', 'BatchMode=yes');
    }

    const proc = spawn('ssh', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
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

export async function browseRemoteDirectory(
  sshInfo: SshInfo,
  startPath?: string,
): Promise<string | undefined> {
  // Try key-based auth first, prompt for password if it fails
  let askpassPath: string | undefined;

  try {
    await runSshCommand(sshInfo, 'echo ok');
  } catch {
    // Key auth failed — ask for password
    const password = await vscode.window.showInputBox({
      prompt: `Password for ${sshInfo.sshUser ? sshInfo.sshUser + '@' : ''}${sshInfo.sshHost}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) { return undefined; }

    askpassPath = createAskpassHelper(password);

    // Verify the password works
    try {
      await runSshCommand(sshInfo, 'echo ok', askpassPath);
    } catch (err: any) {
      cleanupAskpass(askpassPath);
      vscode.window.showErrorMessage(`SSH authentication failed: ${err.message}`);
      return undefined;
    }
  }

  try {
    return await doBrowse(sshInfo, askpassPath, startPath);
  } finally {
    cleanupAskpass(askpassPath);
  }
}

function cleanupAskpass(askpassPath: string | undefined): void {
  if (askpassPath) {
    try { fs.unlinkSync(askpassPath); } catch { /* ignore */ }
  }
}

async function doBrowse(
  sshInfo: SshInfo,
  askpassPath: string | undefined,
  startPath?: string,
): Promise<string | undefined> {
  let currentPath: string;

  if (startPath) {
    currentPath = startPath;
  } else {
    try {
      currentPath = (await runSshCommand(sshInfo, 'echo $HOME', askpassPath)).trim();
    } catch {
      currentPath = '/';
    }
  }

  // Normalise: ensure leading /, no trailing / (except root)
  if (!currentPath.startsWith('/')) {
    currentPath = '/' + currentPath;
  }

  while (true) {
    // List directory entries
    let entries: string[];
    try {
      const raw = await runSshCommand(sshInfo, `ls -1 -p ${escapeShellArg(currentPath)}`, askpassPath);
      entries = raw
        .split('\n')
        .map(e => e.trim())
        .filter(e => e.endsWith('/'))
        .map(e => e.slice(0, -1)); // strip trailing /
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list remote directory: ${err.message}`);
      return undefined;
    }

    // Build QuickPick items
    const items: (vscode.QuickPickItem & { action?: string })[] = [];

    items.push({
      label: `$(folder-opened) Select: ${currentPath}`,
      action: 'select',
    });

    items.push({
      label: '$(new-folder) Create new directory here...',
      action: 'create',
    });

    if (currentPath !== '/') {
      items.push({
        label: '..',
        description: 'Go up one level',
        action: 'up',
      });
    }

    for (const dir of entries.sort()) {
      items.push({
        label: dir,
        description: 'directory',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: currentPath,
      title: 'Browse Remote Directory',
    });

    if (!picked) {
      return undefined; // user pressed Esc
    }

    if (picked.action === 'select') {
      return currentPath;
    }

    if (picked.action === 'create') {
      const name = await vscode.window.showInputBox({
        prompt: `New directory name inside ${currentPath}`,
        placeHolder: 'my-project',
        validateInput: (v) => {
          if (!v.trim()) { return 'Name cannot be empty'; }
          if (v.includes('/')) { return 'Name cannot contain /'; }
          return undefined;
        },
      });
      if (!name) { continue; }

      const newPath = currentPath === '/'
        ? '/' + name.trim()
        : currentPath + '/' + name.trim();

      try {
        await runSshCommand(sshInfo, `mkdir -p ${escapeShellArg(newPath)}`, askpassPath);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create directory: ${err.message}`);
        continue;
      }

      return newPath;
    }

    if (picked.action === 'up') {
      const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
      currentPath = parent;
      continue;
    }

    // Navigate into subdirectory
    currentPath = currentPath === '/'
      ? '/' + picked.label
      : currentPath + '/' + picked.label;
  }
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
