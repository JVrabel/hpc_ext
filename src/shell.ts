import * as vscode from 'vscode';
import type { HpcProfile } from './types';

export function openRemoteShell(profile: HpcProfile): void {
  const args: string[] = [];

  if (profile.sshPort) {
    args.push('-p', String(profile.sshPort));
  }
  if (profile.sshIdentityFile) {
    args.push('-i', profile.sshIdentityFile);
  }

  args.push('-o', 'ForwardAgent=no');

  const host = profile.sshUser ? `${profile.sshUser}@${profile.sshHost}` : profile.sshHost;
  args.push(host);

  // cd to remote project dir and start login shell
  args.push('-t', `cd ${escapeShellArg(profile.remoteProjectDir)} && exec $SHELL -l`);

  const terminal = vscode.window.createTerminal({
    name: `HPC: ${profile.name}`,
    shellPath: 'ssh',
    shellArgs: args,
  });

  terminal.show();
}

function escapeShellArg(arg: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
