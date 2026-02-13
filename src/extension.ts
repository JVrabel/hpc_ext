import * as vscode from 'vscode';
import { createOutputChannel } from './outputChannel';
import { StatusBarManager } from './statusBar';
import { SyncEngine } from './sync';
import { SidebarProvider } from './views/sidebarProvider';
import { ProfileEditorProvider } from './views/profileEditorProvider';
import { getActiveProfile, selectProfileQuickPick, setActiveProfile } from './profiles';
import { openRemoteShell } from './shell';
import { setupSshKey } from './sshKeySetup';
import { SyncState } from './types';
import { RemoteFileExplorer } from './views/remoteFileExplorer';

export function activate(context: vscode.ExtensionContext) {
  const output = createOutputChannel();
  const statusBar = new StatusBarManager();
  const syncEngine = new SyncEngine(output, statusBar);
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
    <li>Click <strong>Push to Remote</strong> to sync files, or <strong>Open Remote Shell</strong> to work on the server.</li>
  </ol>

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
  (sync, browse, shell) connect automatically.</p>
  <p>Use the <strong>Setup SSH Key</strong> button in the sidebar, or do it manually:</p>
  <pre>ssh-keygen -t ed25519
ssh-copy-id user@your-hpc-host</pre>
  <p>You'll enter your password one last time. After that, SSH keys handle authentication.</p>
  <p><span class="tip">Tip:</span> No admin access is needed — any user can set up SSH keys.</p>

  <h2>Syncing Files</h2>
  <ul>
    <li><strong>Push to Remote</strong> — uploads local files to the remote directory.</li>
    <li><strong>Push (Dry Run)</strong> — shows what <em>would</em> be synced without actually transferring (rsync only).</li>
    <li><strong>rsync</strong> is preferred (incremental, supports exclude patterns). If not found, the extension falls back to <code>scp</code> (full copy, no excludes).</li>
    <li>On Windows, install rsync via <strong>WSL</strong> (<code>wsl sudo apt install rsync</code>) or <strong>MSYS2/Git Bash</strong> for the best experience.</li>
  </ul>

  <h2>Exclude Patterns</h2>
  <p>When using rsync, you can exclude files/folders from sync. Common patterns:</p>
  <pre>.git
node_modules
__pycache__
.venv
*.pyc</pre>

  <h2>Remote Shell</h2>
  <p><strong>Open Remote Shell</strong> opens an SSH terminal inside VS Code, landing directly
  in your remote project directory. The connection stays alive for up to 1 hour of inactivity.</p>

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
