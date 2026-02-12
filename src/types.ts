export interface HpcProfile {
  name: string;
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshIdentityFile?: string;
  remoteProjectDir: string;
  localProjectDir: string;
  syncMode: 'push' | 'pull' | 'both';
  excludePatterns: string[];
  deleteOnSync: boolean;
  remoteTreeRoot?: string;
  remoteTreeDepth?: number;
}

export enum SyncState {
  Idle = 'idle',
  Syncing = 'syncing',
  Synced = 'synced',
  Dirty = 'dirty',
  Error = 'error',
}
