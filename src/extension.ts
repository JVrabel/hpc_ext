import * as vscode from 'vscode';
import { createOutputChannel } from './outputChannel';
import { StatusBarManager } from './statusBar';
import { SyncEngine } from './sync';
import { SidebarProvider } from './views/sidebarProvider';
import { ProfileEditorProvider } from './views/profileEditorProvider';
import { getActiveProfile, selectProfileQuickPick, setActiveProfile } from './profiles';
import { openRemoteShell } from './shell';
import { SyncState } from './types';

export function activate(context: vscode.ExtensionContext) {
  const output = createOutputChannel();
  const statusBar = new StatusBarManager();
  const syncEngine = new SyncEngine(output, statusBar);
  const sidebar = new SidebarProvider();
  const profileEditor = new ProfileEditorProvider(context.extensionUri);

  // Register sidebar tree view
  const treeView = vscode.window.createTreeView('hpc-sync.sidebar', {
    treeDataProvider: sidebar,
  });

  // Restore active profile
  const activeProfile = getActiveProfile(context);
  if (activeProfile) {
    sidebar.setActiveProfile(activeProfile);
    statusBar.setState(SyncState.Idle, activeProfile.name);
  }

  // When profiles change in the editor, refresh sidebar
  profileEditor.onProfilesChanged(() => {
    const current = getActiveProfile(context);
    sidebar.setActiveProfile(current);
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
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hpc-sync.selectProfile', async () => {
      const profile = await selectProfileQuickPick(context);
      if (profile) {
        sidebar.setActiveProfile(profile);
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
  );

  context.subscriptions.push(treeView, statusBar, profileEditor, sidebar);
}

export function deactivate() {}
