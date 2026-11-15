/** A separate negotiated extension. Never add these keys to pairing v1. */
export const SESSION_TOOLS_VERSION = 1 as const;
export const FILE_PROTOCOL_VERSION = 2 as const;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_SESSION_BYTES = 5 * 1024 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 16 * 1024;
export type ToolBinding = {
  deviceId: string; sessionId: string; authorizationId: string;
  controllerId: string; peerId: string;
};
export type RemoteRoot = { id: string; name: string };
export type RemoteEntry = {
  name: string; path: string; directory: boolean; size: number; revision: string;
};
export type RemoteDirectory = {
  rootId: string; path: string; entries: RemoteEntry[]; next: string | null;
};
export type MicrophonePhase = "off" | "requesting" | "sharing" | "locally_stopped" |
  "permission_denied" | "device_unavailable" | "transport_failure";
export type VerificationPhase = "idle" | "unsupported" | "approval_required" |
  "in_progress" | "cancelled" | "result_unconfirmed";
export type SetupRequirement = "ready" | "required" | "unavailable" | "unconfirmed";
export type VerificationSetup = {
  localApproval: SetupRequirement; helperInstallation: SetupRequirement;
  protectedIdentity: SetupRequirement; encryptionEnrollment: SetupRequirement;
  savedCredential: SetupRequirement; connectivity: SetupRequirement;
  lockScreen: "available" | "not_locked" | "unavailable";
  appVerification: "on_device_only";
};
export type SessionToolsState = {
  supported: boolean; roots: RemoteRoot[]; microphoneAllowed: boolean;
  microphone: MicrophonePhase; verification: VerificationPhase;
  requestId: string | null; reason: string | null; setup: VerificationSetup | null;
};
export const EMPTY_SESSION_TOOLS: SessionToolsState = {
  supported: false, roots: [], microphoneAllowed: false, microphone: "off",
  verification: "idle", requestId: null, reason: null, setup: null,
};
export type SessionToolsClient = {
  state(): SessionToolsState;
  onState(callback: (state: SessionToolsState) => void): () => void;
  refresh(): Promise<void>;
  list(rootId: string, path: string, cursor?: string | null, signal?: AbortSignal): Promise<RemoteDirectory>;
  download(rootId: string, entry: RemoteEntry, signal?: AbortSignal): Promise<void>;
  cancelDownload(): void;
  microphone(listen: boolean): Promise<void>;
  verifyOnDevice(scenario: "autofill" | "saved_passwords" | "passkey"): Promise<void>;
  cancelVerification(): void;
  finishVerification(): void;
  close(): void;
};
