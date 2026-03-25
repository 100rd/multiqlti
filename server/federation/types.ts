export interface FederationConfig {
  enabled: boolean;
  instanceId: string;
  instanceName: string;
  clusterSecret: string;
  listenPort: number;
  peers: string[]; // static peer URLs
}

export interface PeerInfo {
  instanceId: string;
  instanceName: string;
  endpoint: string;
  connectedAt: Date;
  lastMessageAt: Date;
  status: "connected" | "disconnected" | "connecting";
}

export interface FederationMessage {
  type: string;
  from: string;
  to?: string;
  correlationId: string;
  payload: unknown;
  hmac: string;
  timestamp: number;
}

export type FederationMessageHandler = (
  msg: FederationMessage,
  peer: PeerInfo,
) => void | Promise<void>;
