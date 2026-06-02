import * as vscode from 'vscode';
import type { HpcProfile } from '../types';
import { SshSession, RemoteEntry } from '../sshSession';

// ---------- Tree items ----------

export class RemoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: RemoteEntry,
    public readonly remotePath: string,
  ) {
    super(
      entry.name,
      entry.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // Wiring resourceUri lets VS Code's active icon theme render the proper
    // file/folder icon and apply consistent tree-row spacing.
    this.resourceUri = vscode.Uri.parse(`hpc-remote://${remotePath}`);

    if (entry.isDirectory) {
      this.contextValue = 'folder';
    } else {
      this.contextValue = 'file';
      this.command = {
        command: 'vscode.open',
        title: 'Open Remote File',
        arguments: [this.resourceUri],
      };
    }

    this.tooltip = remotePath;
  }
}

class RootHeaderItem extends vscode.TreeItem {
  constructor(currentRoot: string) {
    super(currentRoot, vscode.TreeItemCollapsibleState.None);
    this.description = 'change…';
    this.tooltip = `Browsing: ${currentRoot}\nClick to navigate to a different path.`;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'rootHeader';
    this.command = {
      command: 'hpc-sync.changeRemoteRoot',
      title: 'Change remote root',
    };
  }
}

type ExplorerItem = RemoteTreeItem | RootHeaderItem;

// ---------- Explorer (TreeDataProvider + FileSystemProvider) ----------

export class RemoteFileExplorer
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.FileSystemProvider
{
  private profile: HpcProfile | undefined;
  private session: SshSession | undefined;
  private _connected = false;
  private currentRoot: string | undefined;

  // TreeDataProvider events
  private _onDidChangeTreeData = new vscode.EventEmitter<ExplorerItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // FileSystemProvider events
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  get connected(): boolean {
    return this._connected;
  }

  getCurrentRoot(): string | undefined {
    if (!this.profile) { return undefined; }
    return this.currentRoot ?? this.profile.remoteTreeRoot ?? this.profile.remoteProjectDir;
  }

  // ---- Profile management ----

  setActiveProfile(profile: HpcProfile | undefined): void {
    // Disconnect and reset session-only root when profile changes.
    if (this._connected) {
      this.disconnectInternal();
    }
    this.profile = profile;
    this.currentRoot = undefined;
    this.updateContext();
    this._onDidChangeTreeData.fire(undefined);
  }

  async connect(): Promise<void> {
    if (!this.profile) {
      vscode.window.showWarningMessage('No active profile. Select one first.');
      return;
    }
    if (this._connected) { return; }

    this.session = new SshSession({
      sshHost: this.profile.sshHost,
      sshUser: this.profile.sshUser,
      sshPort: this.profile.sshPort,
      sshIdentityFile: this.profile.sshIdentityFile,
    });

    try {
      await this.session.ensureAuthenticated();
    } catch (err: any) {
      this.session.dispose();
      this.session = undefined;
      vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
      return;
    }

    this._connected = true;
    this.updateContext();
    this._onDidChangeTreeData.fire(undefined);
  }

  disconnect(): void {
    this.disconnectInternal();
    this._onDidChangeTreeData.fire(undefined);
  }

  private disconnectInternal(): void {
    if (this.session) {
      this.session.dispose();
      this.session = undefined;
    }
    this._connected = false;
    this.updateContext();
  }

  private updateContext(): void {
    vscode.commands.executeCommand('setContext', 'hpc-sync.hasActiveProfile', !!this.profile);
    vscode.commands.executeCommand('setContext', 'hpc-sync.remoteConnected', this._connected);
  }

  refresh(): void {
    if (this.session) {
      this.session.clearCache();
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  async setRoot(newPath: string): Promise<void> {
    if (!this.profile || !this.session || !this._connected) {
      vscode.window.showWarningMessage('Connect to the remote first.');
      return;
    }
    const normalised = normalisePath(newPath);
    try {
      const info = await this.session.stat(normalised);
      if (!info.isDirectory) {
        vscode.window.showErrorMessage(`Not a directory: ${normalised}`);
        return;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cannot access ${normalised}: ${err.message}`);
      return;
    }
    this.currentRoot = normalised;
    this.session.clearCache();
    this._onDidChangeTreeData.fire(undefined);
  }

  // ---- TreeDataProvider ----

  getTreeItem(element: ExplorerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!this.profile || !this.session || !this._connected) {
      return [];
    }

    if (!element) {
      // Top-level: header row + root directory contents.
      const root = this.getCurrentRoot();
      if (!root) { return []; }
      const items: ExplorerItem[] = [new RootHeaderItem(root)];
      const children = await this.listAsItems(root);
      items.push(...children);
      return items;
    }

    if (element instanceof RootHeaderItem) {
      return [];
    }

    // Folder expansion — fully lazy, no artificial depth cap.
    return this.listAsItems(element.remotePath);
  }

  private async listAsItems(dirPath: string): Promise<RemoteTreeItem[]> {
    if (!this.session) { return []; }
    let entries: RemoteEntry[];
    try {
      entries = await this.session.listDirectory(dirPath);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list ${dirPath}: ${err.message}`);
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return entries.map((entry) => {
      const childPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
      return new RemoteTreeItem(entry, childPath);
    });
  }

  // ---- FileSystemProvider ----

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!this.session) {
      throw vscode.FileSystemError.Unavailable('No active SSH session');
    }

    try {
      const info = await this.session.stat(uri.path);
      return {
        type: info.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: info.mtime * 1000,
        mtime: info.mtime * 1000,
        size: info.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    if (!this.session) {
      throw vscode.FileSystemError.Unavailable('No active SSH session');
    }

    const entries = await this.session.listDirectory(uri.path);
    return entries.map((e) => [
      e.name,
      e.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (!this.session) {
      throw vscode.FileSystemError.Unavailable('No active SSH session');
    }

    try {
      return await this.session.readFile(uri.path);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  // Write operations — gated by profile.remoteFilesEditable
  private assertEditable(): void {
    if (!this.profile?.remoteFilesEditable) {
      throw vscode.FileSystemError.NoPermissions(
        'Remote filesystem is read-only. Enable "Allow editing remote files" in the profile to edit.',
      );
    }
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('Creating remote directories is not supported');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    this.assertEditable();
    if (!this.session) {
      throw vscode.FileSystemError.Unavailable('No active SSH session');
    }
    await this.session.writeFile(uri.path, content);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions('Deleting remote files is not supported');
  }
  rename(): never {
    throw vscode.FileSystemError.NoPermissions('Renaming remote files is not supported');
  }

  dispose(): void {
    this.disconnectInternal();
    this._onDidChangeTreeData.dispose();
    this._onDidChangeFile.dispose();
  }
}

function normalisePath(p: string): string {
  let out = p.trim();
  if (!out.startsWith('/')) {
    out = '/' + out;
  }
  // Strip trailing slash except for root.
  if (out.length > 1 && out.endsWith('/')) {
    out = out.replace(/\/+$/, '');
  }
  return out;
}
