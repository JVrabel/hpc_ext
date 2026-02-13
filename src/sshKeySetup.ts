import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import type { HpcProfile } from './types';
import { buildSshArgs, createAskpassHelper, runSshCommand } from './sshUtils';

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

    const result = await runSshCommand(profile, remoteCmd, askpassPath);

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
