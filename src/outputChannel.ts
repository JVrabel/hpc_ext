import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function createOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('HPC Sync');
  }
  return channel;
}
