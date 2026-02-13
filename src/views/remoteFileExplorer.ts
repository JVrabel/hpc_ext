import * as vscode from 'vscode';
import type { HpcProfile } from '../types';
import { SshSession, RemoteEntry } from '../sshSession';

// ---------- Tree item ----------

class RemoteTreeItem extends vscode.TreeItem {
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

    if (entry.isDirectory) {
      this.contextValue = 'folder';
      this.iconPath = new vscode.ThemeIcon('folder');
    } else {
      this.contextValue = 'file';
      this.iconPath = new vscode.ThemeIcon('file');
      // Open file in editor when clicked
      const uri = vscode.Uri.parse(`hpc-remote://${this.remotePath}`);
      this.command = {
        command: 'vscode.open',
        title: 'Open Remote File',
        arguments: [uri],
      };
    }

    this.tooltip = this.remotePath;
  }
}

// ---------- Explorer (TreeDataProvider + FileSystemProvider) ----------

export class RemoteFileExplorer
  implements vscode.TreeDataProvider<RemoteTreeItem>, vscode.FileSystemProvider
{
  private profile: HpcProfile | undefined;
  private session: SshSession | undefined;
  private _connected = false;

  // TreeDataProvider events
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // FileSystemProvider events
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  get connected(): boolean {
    return this._connected;
  }

  // ---- Profile management ----

  setActiveProfile(profile: HpcProfile | undefined): void {
    // Disconnect if profile changes
    if (this._connected) {
      this.disconnectInternal();
    }
    this.profile = profile;
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

  // ---- TreeDataProvider ----

  getTreeItem(element: RemoteTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteTreeItem): Promise<RemoteTreeItem[]> {
    if (!this.profile || !this.session || !this._connected) {
      return [];
    }

    const maxDepth = this.profile.remoteTreeDepth ?? 3;

    let dirPath: string;
    let depth: number;

    if (!element) {
      // Root
      dirPath = this.profile.remoteTreeRoot || this.profile.remoteProjectDir;
      depth = 0;
    } else {
      dirPath = element.remotePath;
      // Calculate depth from root
      const root = this.profile.remoteTreeRoot || this.profile.remoteProjectDir;
      const relative = dirPath.substring(root.length).replace(/^\//, '');
      depth = relative ? relative.split('/').length : 0;
    }

    if (depth >= maxDepth) {
      return [];
    }

    let entries: RemoteEntry[];
    try {
      entries = await this.session.listDirectory(dirPath);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list ${dirPath}: ${err.message}`);
      return [];
    }

    // Sort: directories first, then alphabetical
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
