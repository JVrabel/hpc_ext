import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { HpcProfile } from '../types';
import { saveProfile, deleteProfile, getProfiles } from '../profiles';
import { browseRemoteDirectory } from '../remoteBrowser';

// Imported as text by esbuild
import profileEditorHtml from '../webview/profileEditor.html';
import profileEditorCss from '../webview/profileEditor.css';

export class ProfileEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private onDidChangeProfiles = new vscode.EventEmitter<void>();
  readonly onProfilesChanged = this.onDidChangeProfiles.event;

  constructor(private extensionUri: vscode.Uri) {}

  openEditor(editProfile?: HpcProfile): void {
    if (this.panel) {
      this.panel.reveal();
      if (editProfile) {
        this.panel.webview.postMessage({ type: 'load-profile', profile: editProfile });
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'hpcSyncProfileEditor',
      editProfile ? `Edit: ${editProfile.name}` : 'New HPC Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    if (editProfile) {
      // Small delay to let webview initialize
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'load-profile', profile: editProfile });
      }, 200);
    }

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'save-profile': {
          const profile = msg.profile as HpcProfile;
          await saveProfile(profile);
          vscode.window.showInformationMessage(`Profile "${profile.name}" saved.`);
          this.onDidChangeProfiles.fire();
          this.panel?.dispose();
          break;
        }
        case 'delete-profile': {
          await deleteProfile(msg.name);
          vscode.window.showInformationMessage(`Profile "${msg.name}" deleted.`);
          this.onDidChangeProfiles.fire();
          this.panel?.dispose();
          break;
        }
        case 'browse-folder': {
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Local Project Directory',
          });
          if (uris?.[0]) {
            this.panel?.webview.postMessage({ type: 'set-folder', path: uris[0].fsPath });
          }
          break;
        }
        case 'browse-file': {
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
            openLabel: 'Select SSH Identity File',
          });
          if (uris?.[0]) {
            this.panel?.webview.postMessage({ type: 'set-file', path: uris[0].fsPath });
          }
          break;
        }
        case 'browse-remote': {
          if (!msg.sshHost) {
            vscode.window.showErrorMessage('Please fill in SSH Host before browsing remote directories.');
            break;
          }
          const remotePath = await browseRemoteDirectory({
            sshHost: msg.sshHost,
            sshUser: msg.sshUser,
            sshPort: msg.sshPort,
            sshIdentityFile: msg.sshIdentityFile,
          });
          if (remotePath) {
            this.panel?.webview.postMessage({ type: 'set-remote-folder', path: remotePath });
          }
          break;
        }
        case 'error': {
          vscode.window.showErrorMessage(msg.message);
          break;
        }
        case 'cancel': {
          this.panel?.dispose();
          break;
        }
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  openProfileList(): void {
    const profiles = getProfiles();
    if (profiles.length === 0) {
      this.openEditor();
      return;
    }

    const items: (vscode.QuickPickItem & { profile?: HpcProfile })[] = profiles.map((p) => ({
      label: p.name,
      description: `${p.sshUser ? p.sshUser + '@' : ''}${p.sshHost}`,
      profile: p,
    }));
    items.push({ label: '$(add) Add New Profile', description: '' });

    vscode.window.showQuickPick(items, { placeHolder: 'Select a profile to edit, or add a new one' }).then((picked) => {
      if (!picked) { return; }
      if (picked.profile) {
        this.openEditor(picked.profile);
      } else {
        this.openEditor();
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = webview.cspSource;

    // Create a data URI for the CSS
    const cssUri = `data:text/css;base64,${Buffer.from(profileEditorCss).toString('base64')}`;

    let html = profileEditorHtml;
    html = html.replace(/\{\{nonce\}\}/g, nonce);
    html = html.replace(/\{\{cspSource\}\}/g, cspSource);
    html = html.replace(/\{\{cssUri\}\}/g, cssUri);

    return html;
  }

  dispose(): void {
    this.panel?.dispose();
    this.onDidChangeProfiles.dispose();
  }
}
