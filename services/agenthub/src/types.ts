import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceScope } from '@myagents/agent-network-protocol';

export interface HubConfig {
  issuer: string;
  name: string;
  environment: 'production' | 'development';
  serviceId: string;
  principalId: string;
  networkId: string;
  enrollmentKey: string;
  dataDir: string;
}
export interface AuthContext {
  scope: DeviceScope;
  sessionHandle: string;
  keyFingerprint: string;
  certificateFingerprint: string;
  signedBinding: string;
  expiresAt: number;
}
export interface IdentityDevice {
  deviceId: string;
  name: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  lastAccountSeenAt: string;
}
export interface IdentityApi {
  descriptor(): unknown;
  handle(request: IncomingMessage, url: URL, body: unknown): Promise<unknown>;
  authenticate(request: IncomingMessage): Promise<AuthContext>;
  verifyAccess(token: string): Promise<AuthContext>;
  verifyBinding(token: string): Promise<unknown>;
  devices(): IdentityDevice[];
  onRevoke?: (deviceId: string) => void;
}
export interface Presence {
  auth: AuthContext;
  connectionEpoch: string;
  ready: boolean;
}
export interface TargetMount {
  mountId: string;
  deviceId: string;
  membershipRevision: number;
  enableRevision: number;
}
export interface MetadataApi {
  handle(auth: AuthContext, request: IncomingMessage, url: URL, body: unknown): unknown;
  membershipRevision(deviceId: string): number;
  resolveMount(mountId: string): TargetMount;
  catalogSeq(deviceId: string, connectionEpoch: string): number;
  onChange?: (scope: 'settings' | 'catalog' | 'presence' | 'roster', revision: number) => void;
  setPresenceProvider(provider: (deviceId: string) => Presence | undefined): void;
}
export class HubError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(code);
  }
}
export type HubDatabase = DatabaseSync;
