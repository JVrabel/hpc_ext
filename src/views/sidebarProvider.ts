import * as vscode from 'vscode';
import type { HpcProfile } from '../types';

type SidebarItem =
  | ProfileInfoItem
  | ActionItem
  | QuickActionItem
  | AdvancedGroupItem
  | SeparatorItem;

const ADVANCED_GROUP_ID = 'sync-advanced';

class ProfileInfoItem extends vscode.TreeItem {
  constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'profileInfo';
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string, icon: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: commandId,
      title: label,
      arguments: args,
    };
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'action';
  }
}

class QuickActionItem extends vscode.TreeItem {
  constructor(label: string, index: number, tooltip: string, instantExecute: boolean) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'hpc-sync.runQuickAction',
      title: label,
      arguments: [index],
    };
    this.iconPath = new vscode.ThemeIcon(instantExecute ? 'rocket' : 'edit');
    this.tooltip = `${tooltip}\n\n${instantExecute ? '⏎ Executes immediately.' : '✎ Placed at prompt — press Enter to run.'}`;
    this.description = instantExecute ? '' : '(no auto-run)';
    this.contextValue = 'quickAction';
  }
}

class AdvancedGroupItem extends vscode.TreeItem {
  constructor() {
    super('Sync (advanced)', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('cloud');
    this.contextValue = ADVANCED_GROUP_ID;
    this.id = ADVANCED_GROUP_ID;
  }
}

class SeparatorItem extends vscode.TreeItem {
  constructor() {
    super('', vscode.TreeItemCollapsibleState.None);
    this.description = '────────────────';
    this.contextValue = 'separator';
  }
}

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeProfile: HpcProfile | undefined;

  setActiveProfile(profile: HpcProfile | undefined): void {
    this.activeProfile = profile;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (element instanceof AdvancedGroupItem) {
      return this.getAdvancedChildren();
    }
    return this.getRootItems();
  }

  private getRootItems(): SidebarItem[] {
    const items: SidebarItem[] = [];

    if (this.activeProfile) {
      const p = this.activeProfile;
      items.push(new ProfileInfoItem('Profile', p.name));
      items.push(new ProfileInfoItem('Host', `${p.sshUser ? p.sshUser + '@' : ''}${p.sshHost}`));
      items.push(new ProfileInfoItem('Remote', p.remoteProjectDir));
      items.push(new ProfileInfoItem('Local', p.localProjectDir));
      items.push(new SeparatorItem());

      // Primary action: open the shell.
      items.push(new ActionItem('Open Remote Shell', 'hpc-sync.openShell', 'terminal'));

      // Per-profile quick actions, each their own row.
      const qas = p.quickActions ?? [];
      qas.forEach((qa, i) => {
        const label = qa.label?.trim() || `Quick Action ${i + 1}`;
        items.push(new QuickActionItem(label, i, qa.command || '(empty command)', qa.instantExecute));
      });

      // Pull-side transfer — separate from upload group because it's used independently.
      items.push(new ActionItem('Download from Remote…', 'hpc-sync.downloadFromRemote', 'cloud-download'));

      items.push(new SeparatorItem());
      items.push(new AdvancedGroupItem());
      items.push(new SeparatorItem());
    } else {
      items.push(new ProfileInfoItem('No profile selected', 'Use "Select Profile" to choose one'));
      items.push(new SeparatorItem());
    }

    items.push(new ActionItem('Select Profile', 'hpc-sync.selectProfile', 'account'));
    items.push(new ActionItem('Manage Profiles', 'hpc-sync.editProfiles', 'gear'));
    items.push(new SeparatorItem());
    items.push(new ActionItem('Help', 'hpc-sync.showHelp', 'question'));

    return items;
  }

  private getAdvancedChildren(): SidebarItem[] {
    const items: SidebarItem[] = [];
    items.push(new ActionItem('Push to Remote', 'hpc-sync.push', 'cloud-upload'));
    items.push(new ActionItem('Push (Dry Run)', 'hpc-sync.pushDryRun', 'eye'));
    if (this.activeProfile) {
      items.push(new ActionItem('Setup SSH Key', 'hpc-sync.setupSshKey', 'key'));
    }
    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
