# HPC Sync

VS Code extension for working with remote HPC clusters that restrict port forwarding, prohibit VS Code Remote/SSH sessions, or sit behind login nodes that only allow basic SSH access.

Edit code locally, push files to the cluster via rsync or scp, browse remote files from the sidebar, and open SSH shells — all without requiring open ports, remote servers, or admin privileges.

## Platform Support

Works on **Windows**, **macOS**, and **Linux**. Requires `ssh` on PATH (included by default on all three).

| Platform | Sync tool | Notes |
|----------|-----------|-------|
| **Linux / macOS** | rsync (preferred), scp fallback | rsync is typically pre-installed |
| **Windows** | rsync via WSL or Git Bash, scp fallback | Install rsync through WSL (`wsl sudo apt install rsync`) or use Git for Windows which bundles it. If neither is available, falls back to scp (full copy, no exclude patterns, no incremental sync) |

## Features

- **Profile-based** — save multiple HPC connections (host, user, paths, exclude patterns)
- **Remote Shell** — open an SSH terminal landing in your project directory
- **Quick Actions** — per-profile one-tap commands sent to the HPC terminal (e.g. `salloc …`, env activation, job launch). Optional "instant execute" toggle per action.
- **Download from Remote** — pull files or whole folders to local via rsync (with progress, cancellable) or scp fallback; key-based auth, no passwords
- **Remote File Explorer** — browse remote files; jump to any path on demand without editing the profile; deep folders work without artificial depth caps
- **Push to Remote** — sync local project to remote directory (incremental with rsync), tucked under "Sync (advanced)" since most workflows lean on the shell
- **SSH Key Setup** — one-click key generation and installation on the remote host
- **Dry Run** — preview what would be synced before transferring (rsync only)

### Tip — tree indentation

If the Remote Files tree reads "flat", set `"workbench.tree.indent": 20` (or higher) in VS Code settings. That widens the per-level indent for every tree view in VS Code.

## Install from .vsix

1. Download `hpc-sync-0.2.0.vsix` from this repository
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → select the file

Or from the command line:

```
code --install-extension hpc-sync-0.2.0.vsix
```

## Build from source

Requires Node.js 18+.

```
npm install
npm run build
npm run package
```

This produces `hpc-sync-<version>.vsix` in the project root.

## License

[MIT](LICENSE) — attribution required for redistribution.
