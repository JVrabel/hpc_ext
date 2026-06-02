import * as vscode from 'vscode';
import {
  SshInfo,
  createAskpassHelper,
  cleanupAskpass,
  runSshCommand,
  escapeShellArg,
} from './sshUtils';

export { SshInfo };

export type PickMode = 'directory' | 'fileOrDirectory';

export interface RemoteBrowsePick {
  path: string;
  isDirectory: boolean;
}

export async function browseRemoteDirectory(
  sshInfo: SshInfo,
  startPath?: string,
): Promise<string | undefined> {
  const pick = await browseRemote(sshInfo, { startPath, pickMode: 'directory' });
  return pick?.path;
}

export async function browseRemote(
  sshInfo: SshInfo,
  options: { startPath?: string; pickMode?: PickMode } = {},
): Promise<RemoteBrowsePick | undefined> {
  const pickMode = options.pickMode ?? 'directory';

  // Try key-based auth first, prompt for password if it fails
  let askpassPath: string | undefined;

  try {
    await runSshCommand(sshInfo, 'echo ok');
  } catch {
    // Key auth failed — ask for password
    const password = await vscode.window.showInputBox({
      prompt: `Password for ${sshInfo.sshUser ? sshInfo.sshUser + '@' : ''}${sshInfo.sshHost}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) { return undefined; }

    askpassPath = createAskpassHelper(password);

    try {
      await runSshCommand(sshInfo, 'echo ok', askpassPath);
    } catch (err: any) {
      cleanupAskpass(askpassPath);
      vscode.window.showErrorMessage(`SSH authentication failed: ${err.message}`);
      return undefined;
    }
  }

  try {
    return await doBrowse(sshInfo, askpassPath, options.startPath, pickMode);
  } finally {
    cleanupAskpass(askpassPath);
  }
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
}

async function doBrowse(
  sshInfo: SshInfo,
  askpassPath: string | undefined,
  startPath: string | undefined,
  pickMode: PickMode,
): Promise<RemoteBrowsePick | undefined> {
  let currentPath: string;

  if (startPath) {
    currentPath = startPath;
  } else {
    try {
      currentPath = (await runSshCommand(sshInfo, 'echo $HOME', askpassPath)).trim();
    } catch {
      currentPath = '/';
    }
  }

  if (!currentPath.startsWith('/')) {
    currentPath = '/' + currentPath;
  }

  while (true) {
    let entries: DirEntry[];
    try {
      const raw = await runSshCommand(
        sshInfo,
        `ls -1 -p ${escapeShellArg(currentPath)}`,
        askpassPath,
      );
      entries = raw
        .split('\n')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => {
          if (e.endsWith('/')) {
            return { name: e.slice(0, -1), isDirectory: true };
          }
          return { name: e, isDirectory: false };
        });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list remote directory: ${err.message}`);
      return undefined;
    }

    const items: (vscode.QuickPickItem & { action?: string; entry?: DirEntry })[] = [];

    items.push({
      label: `$(folder-opened) Select folder: ${currentPath}`,
      action: 'select-dir',
    });

    if (pickMode === 'directory') {
      items.push({
        label: '$(new-folder) Create new directory here…',
        action: 'create',
      });
    }

    if (currentPath !== '/') {
      items.push({
        label: '..',
        description: 'Go up one level',
        action: 'up',
      });
    }

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const ent of sorted) {
      if (ent.isDirectory) {
        items.push({
          label: `$(folder) ${ent.name}`,
          description: 'directory',
          entry: ent,
        });
      } else if (pickMode === 'fileOrDirectory') {
        items.push({
          label: `$(file) ${ent.name}`,
          description: 'file',
          action: 'select-file',
          entry: ent,
        });
      }
      // Files in directory-only mode are hidden.
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: currentPath,
      title: pickMode === 'fileOrDirectory' ? 'Pick remote file or folder' : 'Browse Remote Directory',
    });

    if (!picked) {
      return undefined;
    }

    if (picked.action === 'select-dir') {
      return { path: currentPath, isDirectory: true };
    }

    if (picked.action === 'select-file' && picked.entry) {
      const filePath = currentPath === '/' ? '/' + picked.entry.name : currentPath + '/' + picked.entry.name;
      return { path: filePath, isDirectory: false };
    }

    if (picked.action === 'create') {
      const name = await vscode.window.showInputBox({
        prompt: `New directory name inside ${currentPath}`,
        placeHolder: 'my-project',
        validateInput: (v) => {
          if (!v.trim()) { return 'Name cannot be empty'; }
          if (v.includes('/')) { return 'Name cannot contain /'; }
          return undefined;
        },
      });
      if (!name) { continue; }

      const newPath = currentPath === '/'
        ? '/' + name.trim()
        : currentPath + '/' + name.trim();

      try {
        await runSshCommand(sshInfo, `mkdir -p ${escapeShellArg(newPath)}`, askpassPath);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create directory: ${err.message}`);
        continue;
      }

      return { path: newPath, isDirectory: true };
    }

    if (picked.action === 'up') {
      const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
      currentPath = parent;
      continue;
    }

    // Navigate into subdirectory
    if (picked.entry?.isDirectory) {
      currentPath = currentPath === '/'
        ? '/' + picked.entry.name
        : currentPath + '/' + picked.entry.name;
    }
  }
}
