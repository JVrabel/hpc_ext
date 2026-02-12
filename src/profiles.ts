import * as vscode from 'vscode';
import type { HpcProfile } from './types';

const ACTIVE_PROFILE_KEY = 'hpc-sync.activeProfile';

export function getProfiles(): HpcProfile[] {
  const config = vscode.workspace.getConfiguration('hpc-sync');
  const raw = config.get<HpcProfile[]>('profiles', []);
  return raw.map((p) => ({
    ...p,
    syncMode: p.syncMode ?? 'push',
    excludePatterns: p.excludePatterns ?? ['.git', 'node_modules', '__pycache__', '.venv'],
    deleteOnSync: p.deleteOnSync ?? false,
  }));
}

export async function saveProfile(profile: HpcProfile): Promise<void> {
  const config = vscode.workspace.getConfiguration('hpc-sync');
  const profiles = getProfiles();
  const idx = profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  await config.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

export async function deleteProfile(name: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('hpc-sync');
  const profiles = getProfiles().filter((p) => p.name !== name);
  await config.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

export function getActiveProfile(context: vscode.ExtensionContext): HpcProfile | undefined {
  const activeName = context.globalState.get<string>(ACTIVE_PROFILE_KEY);
  if (!activeName) { return undefined; }
  return getProfiles().find((p) => p.name === activeName);
}

export async function setActiveProfile(context: vscode.ExtensionContext, name: string): Promise<void> {
  await context.globalState.update(ACTIVE_PROFILE_KEY, name);
}

export async function selectProfileQuickPick(context: vscode.ExtensionContext): Promise<HpcProfile | undefined> {
  const profiles = getProfiles();
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No HPC profiles configured. Use "Manage Profiles" to add one.');
    return undefined;
  }

  const items = profiles.map((p) => ({
    label: p.name,
    description: `${p.sshUser ? p.sshUser + '@' : ''}${p.sshHost}:${p.remoteProjectDir}`,
    profile: p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an HPC profile',
  });

  if (picked) {
    await setActiveProfile(context, picked.profile.name);
    return picked.profile;
  }
  return undefined;
}
