# HPC Sync

VS Code extension for syncing local projects to remote HPC/Linux servers via SSH.

## Install from .vsix

1. Download `hpc-sync-0.1.0.vsix` from this repository
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → select the file

Or from the command line:

```
code --install-extension hpc-sync-0.1.0.vsix
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
