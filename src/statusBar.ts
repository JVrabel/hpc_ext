import * as vscode from 'vscode';
import { SyncState } from './types';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'hpc-sync.push';
    this.setState(SyncState.Idle);
    this.item.show();
  }

  setState(state: SyncState, profileName?: string): void {
    switch (state) {
      case SyncState.Idle:
        this.item.text = `$(cloud) HPC${profileName ? ': ' + profileName : ''}`;
        this.item.tooltip = profileName ? `HPC Sync — ${profileName} (idle)` : 'HPC Sync — no profile selected';
        this.item.backgroundColor = undefined;
        break;
      case SyncState.Syncing:
        this.item.text = '$(sync~spin) Syncing...';
        this.item.tooltip = 'HPC Sync — syncing in progress';
        this.item.backgroundColor = undefined;
        break;
      case SyncState.Synced:
        this.item.text = `$(check) Synced${profileName ? ': ' + profileName : ''}`;
        this.item.tooltip = 'HPC Sync — last sync completed successfully';
        this.item.backgroundColor = undefined;
        break;
      case SyncState.Dirty:
        this.item.text = `$(warning) HPC${profileName ? ': ' + profileName : ''}`;
        this.item.tooltip = 'HPC Sync — local changes not synced';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case SyncState.Error:
        this.item.text = `$(error) Sync Error`;
        this.item.tooltip = 'HPC Sync — last sync failed (click to retry)';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
