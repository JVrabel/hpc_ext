import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import type { HpcProfile } from './types';

const KEY_PATH = path.join(os.homedir(), '.ssh', 'id_ed25519');
const PUB_PATH = KEY_PATH + '.pub';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); }
      else { resolve({ stdout, stderr }); }
    });
  });
}

/** Create a temporary askpass helper that echoes the password (same approach as remoteBrowser). */
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

function runSshWithAskpass(profile: HpcProfile, command: string, askpassPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (profile.sshPort) { args.push('-p', String(profile.sshPort)); }
    if (profile.sshIdentityFile) { args.push('-i', profile.sshIdentityFile); }
    args.push('-o', 'StrictHostKeyChecking=accept-new');

    const host = profile.sshUser ? `${profile.sshUser}@${profile.sshHost}` : profile.sshHost;
    args.push(host, command);

    const env: Record<string, string | undefined> = {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: ':0',
    };

    const proc = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) { resolve(stdout); }
      else { reject(new Error(stderr.trim() || `SSH exited with code ${code}`)); }
    });
    proc.on('error', (err) => reject(err));
  });
}

export async function setupSshKey(profile: HpcProfile): Promise<void> {
  const host = profile.sshUser ? `${profile.sshUser}@${profile.sshHost}` : profile.sshHost;

  // Step 1: ensure key exists
  if (!fs.existsSync(PUB_PATH)) {
    const generate = await vscode.window.showInformationMessage(
      'No SSH key found. Generate a new ed25519 key?',
      'Generate', 'Cancel',
    );
    if (generate !== 'Generate') { return; }

    const sshDir = path.dirname(KEY_PATH);
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true });
    }

    try {
      await run('ssh-keygen', ['-t', 'ed25519', '-f', KEY_PATH, '-N', '']);
      vscode.window.showInformationMessage('SSH key generated successfully.');
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to generate SSH key: ${err.message}`);
      return;
    }
  }

  // Step 2: read public key
  let pubKey: string;
  try {
    pubKey = fs.readFileSync(PUB_PATH, 'utf-8').trim();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to read public key: ${err.message}`);
    return;
  }

  // Step 3: confirm
  const confirm = await vscode.window.showInformationMessage(
    `Copy SSH public key to ${host}?`,
    'Copy Key', 'Cancel',
  );
  if (confirm !== 'Copy Key') { return; }

  // Step 4: prompt for password
  const password = await vscode.window.showInputBox({
    prompt: `Password for ${host}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) { return; }

  const askpassPath = createAskpassHelper(password);

  try {
    // Use base64 to safely transfer the public key without quoting issues
    const b64Key = Buffer.from(pubKey).toString('base64');
    const remoteCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo $(echo '${b64Key}' | base64 -d) >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED`;

    const result = await runSshWithAskpass(profile, remoteCmd, askpassPath);

    if (result.includes('KEY_INSTALLED')) {
      vscode.window.showInformationMessage(
        `SSH key installed on ${host}. Password-free authentication is now active.`,
      );
    } else {
      vscode.window.showWarningMessage('SSH key may not have been installed correctly. Try connecting to verify.');
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to copy SSH key: ${err.message}`);
  } finally {
    try { fs.unlinkSync(askpassPath); } catch { /* ignore */ }
  }
}
