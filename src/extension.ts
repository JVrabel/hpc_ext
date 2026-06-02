import * as vscode from 'vscode';
import { createOutputChannel } from './outputChannel';
import { StatusBarManager } from './statusBar';
import { SyncEngine } from './sync';
import { DownloadEngine } from './download';
import { SidebarProvider } from './views/sidebarProvider';
import { ProfileEditorProvider } from './views/profileEditorProvider';
import { getActiveProfile, selectProfileQuickPick } from './profiles';
import { openRemoteShell, runQuickAction } from './shell';
import { setupSshKey } from './sshKeySetup';
import { SyncState } from './types';
import { RemoteFileExplorer, RemoteTreeItem } from './views/remoteFileExplorer';
import { browseRemote } from './remoteBrowser';

export function activate(context: vscode.ExtensionContext) {
  const output = createOutputChannel();
  const statusBar = new StatusBarManager();
  const syncEngine = new SyncEngine(output, statusBar);
  const downloadEngine = new DownloadEngine(output);
  const sidebar = new SidebarProvider();
  const profileEditor = new ProfileEditorProvider(context.extensionUri);

  const remoteExplorer = new RemoteFileExplorer();

  // Register sidebar tree view
  const treeView = vscode.window.createTreeView('hpc-sync.sidebar', {
    treeDataProvider: sidebar,
  });

  // Register remote files tree view
  const remoteTreeView = vscode.window.createTreeView('hpc-sync.remoteFiles', {
    treeDataProvider: remoteExplorer,
  });

  // Register filesystem provider for hpc-remote:// URIs
  // Write permission is gated per-profile by remoteFilesEditable
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('hpc-remote', remoteExplorer),
  );

  // Restore active profile
  const activeProfile = getActiveProfile(context);
  if (activeProfile) {
    sidebar.setActiveProfile(activeProfile);
    remoteExplorer.setActiveProfile(activeProfile);
    statusBar.setState(SyncState.Idle, activeProfile.name);
  }

  // When profiles change in the editor, refresh sidebar + remote explorer
  profileEditor.onProfilesChanged(() => {
    const current = getActiveProfile(context);
    sidebar.setActiveProfile(current);
    remoteExplorer.setActiveProfile(current);
    if (current) {
      statusBar.setState(SyncState.Idle, current.name);
    }
  });

  // Also refresh when settings change externally
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hpc-sync.profiles')) {
        const current = getActiveProfile(context);
        sidebar.setActiveProfile(current);
        remoteExplorer.setActiveProfile(current);
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hpc-sync.selectProfile', async () => {
      const profile = await selectProfileQuickPick(context);
      if (profile) {
        sidebar.setActiveProfile(profile);
        remoteExplorer.setActiveProfile(profile);
        statusBar.setState(SyncState.Idle, profile.name);
      }
    }),

    vscode.commands.registerCommand('hpc-sync.editProfiles', () => {
      profileEditor.openProfileList();
    }),

    vscode.commands.registerCommand('hpc-sync.push', async () => {
      const profile = getActiveProfile(context);
      if (!profile) {
        const selected = await selectProfileQuickPick(context);
        if (!selected) { return; }
        sidebar.setActiveProfile(selected);
        remoteExplorer.setActiveProfile(selected);
        statusBar.setState(SyncState.Idle, selected.name);
        await syncEngine.push(selected, false);
        return;
      }
      await syncEngine.push(profile, false);
    }),

    vscode.commands.registerCommand('hpc-sync.pushDryRun', async () => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      await syncEngine.push(profile, true);
    }),

    vscode.commands.registerCommand('hpc-sync.openShell', async () => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      openRemoteShell(profile);
    }),

    vscode.commands.registerCommand('hpc-sync.runQuickAction', async (index: number) => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      const qas = profile.quickActions ?? [];
      const action = qas[index];
      if (!action) {
        vscode.window.showWarningMessage('Quick action not found. The profile may have changed.');
        return;
      }
      await runQuickAction(profile, action);
    }),

    vscode.commands.registerCommand('hpc-sync.cancelSync', () => {
      syncEngine.cancel();
    }),

    vscode.commands.registerCommand('hpc-sync.setupSshKey', async () => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      await setupSshKey(profile);
    }),

    vscode.commands.registerCommand('hpc-sync.connectRemote', async () => {
      await remoteExplorer.connect();
    }),

    vscode.commands.registerCommand('hpc-sync.disconnectRemote', () => {
      remoteExplorer.disconnect();
    }),

    vscode.commands.registerCommand('hpc-sync.refreshRemoteFiles', () => {
      remoteExplorer.refresh();
    }),

    vscode.commands.registerCommand('hpc-sync.changeRemoteRoot', async () => {
      if (!remoteExplorer.connected) {
        vscode.window.showWarningMessage('Connect to the remote first.');
        return;
      }
      const current = remoteExplorer.getCurrentRoot() ?? '/';
      const newPath = await vscode.window.showInputBox({
        prompt: 'Remote path to browse (absolute, e.g. /scratch/jvrabel/runs)',
        value: current,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'Path cannot be empty'),
      });
      if (!newPath) { return; }
      await remoteExplorer.setRoot(newPath.trim());
    }),

    vscode.commands.registerCommand('hpc-sync.downloadFromRemote', async () => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      const startPath = remoteExplorer.getCurrentRoot() ?? profile.remoteProjectDir;
      const pick = await browseRemote(
        {
          sshHost: profile.sshHost,
          sshUser: profile.sshUser,
          sshPort: profile.sshPort,
          sshIdentityFile: profile.sshIdentityFile,
        },
        { startPath, pickMode: 'fileOrDirectory' },
      );
      if (!pick) { return; }

      const localDest = await pickLocalDestination();
      if (!localDest) { return; }

      await downloadEngine.download({
        profile,
        remotePath: pick.path,
        isDirectory: pick.isDirectory,
        localDestDir: localDest,
      });
    }),

    vscode.commands.registerCommand('hpc-sync.downloadRemoteItem', async (item: RemoteTreeItem) => {
      const profile = getActiveProfile(context);
      if (!profile) {
        vscode.window.showWarningMessage('No active profile. Select one first.');
        return;
      }
      if (!item || !(item as any).remotePath) {
        vscode.window.showWarningMessage('No remote item selected. Right-click a file or folder in Remote Files.');
        return;
      }

      const localDest = await pickLocalDestination();
      if (!localDest) { return; }

      await downloadEngine.download({
        profile,
        remotePath: item.remotePath,
        isDirectory: item.entry.isDirectory,
        localDestDir: localDest,
      });
    }),

    vscode.commands.registerCommand('hpc-sync.showHelp', () => {
      const panel = vscode.window.createWebviewPanel(
        'hpcSyncHelp',
        'HPC Sync — Help',
        vscode.ViewColumn.One,
        {},
      );
      panel.webview.html = getHelpHtml();
    }),
  );

  context.subscriptions.push(treeView, remoteTreeView, statusBar, profileEditor, sidebar, remoteExplorer);
}

async function pickLocalDestination(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select Local Destination Folder',
  });
  return uris?.[0]?.fsPath;
}

function getHelpHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 28px;
      line-height: 1.6;
    }
    h1 { font-size: 1.5em; margin-top: 0; }
    h2 { font-size: 1.2em; margin-top: 24px; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 4px; }
    code {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 2px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    pre {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 10px 14px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    ul { padding-left: 20px; }
    li { margin-bottom: 4px; }
    .tip { color: var(--vscode-charts-green, #4ec9b0); font-weight: 600; }
  </style>
</head>
<body>
  <h1>HPC Sync</h1>
  <p>Sync your local project to a remote HPC/Linux server via SSH, then open a shell to run jobs.</p>

  <h2>Quick Start</h2>
  <ol>
    <li><strong>Create a profile</strong> — click <em>Manage Profiles → Add New Profile</em>.</li>
    <li>Fill in your <strong>SSH Host</strong> (hostname or SSH config alias) and <strong>Local Project Directory</strong>.</li>
    <li>Click <strong>Browse Remote…</strong> to interactively pick (or create) the remote directory.</li>
    <li><strong>Save</strong> the profile, then <strong>Select Profile</strong> to activate it.</li>
    <li>Click <strong>Open Remote Shell</strong> to work on the server, or expand <strong>Sync (advanced)</strong> for Push/Dry Run.</li>
  </ol>

  <h2>Quick Actions</h2>
  <p>Per-profile one-tap commands shown directly under <strong>Open Remote Shell</strong>. Useful for the steps you type every session
  (e.g. <code>salloc -p gpu --gres=gpu:1</code>, <code>source venv/bin/activate</code>, a job launch command).</p>
  <ul>
    <li>Define them in <strong>Manage Profiles → Edit</strong>. Each has a label, the command, and an "Instant execute" toggle.</li>
    <li>With <strong>Instant execute</strong> on, the command runs immediately. Off, it lands at the terminal prompt and waits for Enter — handy for sanity-checking arguments first.</li>
    <li>If no HPC terminal is open, clicking the action opens one and then sends the command.</li>
  </ul>

  <h2>Download from Remote</h2>
  <p>Pull files or whole folders from the cluster to your local machine over SSH (key-based).</p>
  <ul>
    <li><strong>Download from Remote…</strong> button under Open Shell — opens a remote browser to pick a file or folder.</li>
    <li><strong>Right-click in Remote Files → Download to Local…</strong> — uses the item you clicked.</li>
    <li>Uses <code>rsync</code> if available (progress + resumable), falls back to <code>scp</code>. Key auth only; if it fails, run <strong>Setup SSH Key</strong>.</li>
    <li>Cancel mid-transfer via the progress notification's Cancel button.</li>
  </ul>

  <h2>Remote Files — changing path</h2>
  <p>The Remote Files explorer shows the active profile's remote directory at startup. Click the top row (the path with a "change…" hint),
  or use the <em>go-to-file</em> icon in the view header, to jump to any absolute path on the remote — no profile edit required.
  The override is per-session; switching profiles resets it.</p>
  <p><span class="tip">Tip:</span> If the tree looks visually flat, set <code>"workbench.tree.indent": 20</code> (or higher) in VS Code settings — that controls how much each level indents.</p>

  <h2>SSH Connection</h2>
  <p>The extension uses your system's <code>ssh</code> command. You can configure:</p>
  <ul>
    <li><strong>SSH Host</strong> — a hostname (<code>login.hpc.example.com</code>) or an alias from your <code>~/.ssh/config</code>.</li>
    <li><strong>SSH User</strong> — optional, leave blank if defined in SSH config.</li>
    <li><strong>SSH Port</strong> — optional, defaults to 22.</li>
    <li><strong>SSH Identity File</strong> — optional, path to a private key file.</li>
  </ul>

  <h2>Setting Up SSH Key Authentication (Recommended)</h2>
  <p>Password-based SSH works but is tedious. Setting up key-based auth lets all operations
  (sync, browse, shell, download) connect automatically.</p>
  <p>Use the <strong>Setup SSH Key</strong> button (inside Sync (advanced)), or do it manually:</p>
  <pre>ssh-keygen -t ed25519
ssh-copy-id user@your-hpc-host</pre>
  <p>You'll enter your password one last time. After that, SSH keys handle authentication.</p>
  <p><span class="tip">Tip:</span> No admin access is needed — any user can set up SSH keys.</p>

  <h2>Syncing Files</h2>
  <ul>
    <li><strong>Push to Remote</strong> (inside Sync (advanced)) — uploads local files to the remote directory.</li>
    <li><strong>Push (Dry Run)</strong> — shows what <em>would</em> be synced without actually transferring (rsync only).</li>
    <li><strong>rsync</strong> is preferred (incremental, supports exclude patterns). If not found, the extension falls back to <code>scp</code>.</li>
  </ul>

  <h2>Troubleshooting</h2>
  <ul>
    <li><strong>Permission denied</strong> — SSH key auth not set up. Use <em>Setup SSH Key</em> or enter your password when prompted.</li>
    <li><strong>rsync not found</strong> — install rsync or use WSL. The extension falls back to scp automatically.</li>
    <li><strong>Connection drops</strong> — the extension sends keepalive pings every 60 seconds. If the server still drops you, check the server's SSH timeout settings.</li>
    <li><strong>Browse Remote fails</strong> — make sure SSH Host is filled in and you can connect to the server.</li>
  </ul>
</body>
</html>`;
}

export function deactivate() {}
