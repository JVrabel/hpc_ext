import * as vscode from 'vscode';
import {
  SshInfo,
  buildSshArgs,
  createAskpassHelper,
  cleanupAskpass,
  runSshCommand,
  escapeShellArg,
} from './sshUtils';

export { SshInfo };

export async function browseRemoteDirectory(
  sshInfo: SshInfo,
  startPath?: string,
): Promise<string | undefined> {
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

    // Verify the password works
    try {
      await runSshCommand(sshInfo, 'echo ok', askpassPath);
    } catch (err: any) {
      cleanupAskpass(askpassPath);
      vscode.window.showErrorMessage(`SSH authentication failed: ${err.message}`);
      return undefined;
    }
  }

  try {
    return await doBrowse(sshInfo, askpassPath, startPath);
  } finally {
    cleanupAskpass(askpassPath);
  }
}

async function doBrowse(
  sshInfo: SshInfo,
  askpassPath: string | undefined,
  startPath?: string,
): Promise<string | undefined> {
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

  // Normalise: ensure leading /, no trailing / (except root)
  if (!currentPath.startsWith('/')) {
    currentPath = '/' + currentPath;
  }

  while (true) {
    // List directory entries
    let entries: string[];
    try {
      const raw = await runSshCommand(sshInfo, `ls -1 -p ${escapeShellArg(currentPath)}`, askpassPath);
      entries = raw
        .split('\n')
        .map(e => e.trim())
        .filter(e => e.endsWith('/'))
        .map(e => e.slice(0, -1)); // strip trailing /
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list remote directory: ${err.message}`);
      return undefined;
    }

    // Build QuickPick items
    const items: (vscode.QuickPickItem & { action?: string })[] = [];

    items.push({
      label: `$(folder-opened) Select: ${currentPath}`,
      action: 'select',
    });

    items.push({
      label: '$(new-folder) Create new directory here...',
      action: 'create',
    });

    if (currentPath !== '/') {
      items.push({
        label: '..',
        description: 'Go up one level',
        action: 'up',
      });
    }

    for (const dir of entries.sort()) {
      items.push({
        label: dir,
        description: 'directory',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: currentPath,
      title: 'Browse Remote Directory',
    });

    if (!picked) {
      return undefined; // user pressed Esc
    }

    if (picked.action === 'select') {
      return currentPath;
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

      return newPath;
    }

    if (picked.action === 'up') {
      const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
      currentPath = parent;
      continue;
    }

    // Navigate into subdirectory
    currentPath = currentPath === '/'
      ? '/' + picked.label
      : currentPath + '/' + picked.label;
  }
}
