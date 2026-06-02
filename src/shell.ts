import * as vscode from 'vscode';
import type { HpcProfile, QuickAction } from './types';

export function openRemoteShell(profile: HpcProfile): vscode.Terminal {
  // Always open a fresh session — multiple shells are useful for HPC
  // (long-running job in one, monitoring in another, etc.).
  const args: string[] = [];

  if (profile.sshPort) {
    args.push('-p', String(profile.sshPort));
  }
  if (profile.sshIdentityFile) {
    args.push('-i', profile.sshIdentityFile);
  }

  args.push('-o', 'ForwardAgent=no');
  args.push('-o', 'ServerAliveInterval=60');
  args.push('-o', 'ServerAliveCountMax=60');

  const host = profile.sshUser ? `${profile.sshUser}@${profile.sshHost}` : profile.sshHost;
  args.push(host);

  // cd to remote project dir and start login shell
  args.push('-t', `cd ${escapeShellArg(profile.remoteProjectDir)} && exec $SHELL -l`);

  const terminal = vscode.window.createTerminal({
    name: terminalName(profile),
    shellPath: 'ssh',
    shellArgs: args,
  });

  terminal.show();
  return terminal;
}

export async function runQuickAction(profile: HpcProfile, action: QuickAction): Promise<void> {
  const cmd = (action.command ?? '').trim();
  if (!cmd) {
    vscode.window.showWarningMessage(
      `Quick action "${action.label || 'unnamed'}" has no command. Edit the profile to add one.`,
    );
    return;
  }

  const target = pickQuickActionTerminal(profile);
  if (target) {
    target.show();
    target.sendText(cmd, action.instantExecute);
    return;
  }

  const terminal = openRemoteShell(profile);
  // SSH terminal needs a moment to authenticate and reach the remote prompt.
  // No readiness signal available; small fixed delay is pragmatic.
  await delay(900);
  terminal.sendText(cmd, action.instantExecute);
}

function terminalName(profile: HpcProfile): string {
  return `HPC: ${profile.name}`;
}

/**
 * Pick which terminal a quick action should target.
 *  1. The currently active terminal if it's an HPC shell for this profile.
 *  2. Otherwise the most recently opened matching HPC shell.
 *  3. Otherwise undefined → caller opens a new one.
 */
function pickQuickActionTerminal(profile: HpcProfile): vscode.Terminal | undefined {
  const name = terminalName(profile);
  const active = vscode.window.activeTerminal;
  if (active && active.name === name && active.exitStatus === undefined) {
    return active;
  }
  const matches = vscode.window.terminals.filter(
    (t) => t.name === name && t.exitStatus === undefined,
  );
  return matches[matches.length - 1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeShellArg(arg: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
