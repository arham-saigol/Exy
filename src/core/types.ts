export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface DiscordConfig {
  applicationId: string;
  guildId: string;
  parentChannelId: string;
  authorizedUserId: string;
}

export interface ProviderConfig {
  zernioAccountId: string;
  zernioAccountUsername?: string;
  zernioXAnalyticsEnabled: boolean;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  deliveryThreadId?: string;
}

export interface ExyConfig {
  version: 1;
  discord: DiscordConfig;
  providers: ProviderConfig;
  heartbeat: HeartbeatConfig;
  model?: ModelPreference;
}

export interface ExySecrets {
  discordBotToken: string;
  supermemoryApiKey: string;
  xquikApiKey: string;
  zernioApiKey: string;
  exaApiKey: string;
}

export interface ModelPreference {
  provider: string;
  modelId: string;
  reasoning: ThinkingLevel;
}

export interface Scope {
  discordUserId: string;
  xAccountId: string;
}

export interface ProviderFailureShape {
  provider: string;
  status?: number;
  code?: string;
  message: string;
  retryAfterSeconds?: number;
}
