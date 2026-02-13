import * as vscode from 'vscode';
import type { HpcProfile } from '../types';

type SidebarItem = ProfileInfoItem | ActionItem | SeparatorItem;

class ProfileInfoItem extends vscode.TreeItem {
  constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'profileInfo';
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(
    label: string,
    commandId: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: commandId,
      title: label,
    };
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'action';
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

  getChildren(): SidebarItem[] {
    const items: SidebarItem[] = [];

    if (this.activeProfile) {
      const p = this.activeProfile;
      items.push(new ProfileInfoItem('Profile', p.name));
      items.push(new ProfileInfoItem('Host', `${p.sshUser ? p.sshUser + '@' : ''}${p.sshHost}`));
      items.push(new ProfileInfoItem('Remote', p.remoteProjectDir));
      items.push(new ProfileInfoItem('Local', p.localProjectDir));
      items.push(new SeparatorItem());
      items.push(new ActionItem('Push to Remote', 'hpc-sync.push', 'cloud-upload'));
      items.push(new ActionItem('Push (Dry Run)', 'hpc-sync.pushDryRun', 'eye'));
      items.push(new ActionItem('Open Remote Shell', 'hpc-sync.openShell', 'terminal'));
      items.push(new SeparatorItem());
    } else {
      items.push(new ProfileInfoItem('No profile selected', 'Use "Select Profile" to choose one'));
      items.push(new SeparatorItem());
    }

    items.push(new ActionItem('Select Profile', 'hpc-sync.selectProfile', 'account'));
    items.push(new ActionItem('Manage Profiles', 'hpc-sync.editProfiles', 'gear'));

    if (this.activeProfile) {
      items.push(new ActionItem('Setup SSH Key', 'hpc-sync.setupSshKey', 'key'));
    }

    items.push(new SeparatorItem());
    items.push(new ActionItem('Help', 'hpc-sync.showHelp', 'question'));

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
