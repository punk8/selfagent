import type { AppConfig } from "./config.js";
import {
  loadChannelAccessFile,
  loadChannelProfilesFile,
  saveChannelAccessFile,
  saveChannelProfilesFile,
  type TelegramAuthorizationRequest,
  type TelegramChannelProfile
} from "./state.js";

function randomCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

export function isTelegramUserAllowed(config: AppConfig, userId: number | undefined): boolean {
  const profile = config.defaultChannelProfileId
    ? loadChannelProfilesFile(config.channelsFile).profiles[config.defaultChannelProfileId]
    : undefined;
  if (!profile || profile.kind !== "telegram") {
    return true;
  }
  if (!profile.whitelistEnabled) {
    return true;
  }
  if (userId === undefined) {
    return false;
  }
  return Boolean(profile.allowedUserIds?.includes(userId));
}

export async function createTelegramAuthorizationRequest(
  config: AppConfig,
  expiresInMinutes = 10
): Promise<TelegramAuthorizationRequest> {
  if (!config.defaultChannelProfileId) {
    throw new Error("No default channel profile configured");
  }

  const channelProfiles = loadChannelProfilesFile(config.channelsFile);
  const profile = channelProfiles.profiles[config.defaultChannelProfileId];
  if (!profile || profile.kind !== "telegram") {
    throw new Error("Default channel profile is not a Telegram profile");
  }

  const nextProfile: TelegramChannelProfile = {
    ...profile,
    whitelistEnabled: true,
    allowedUserIds: profile.allowedUserIds ?? []
  };
  channelProfiles.profiles[config.defaultChannelProfileId] = nextProfile;
  await saveChannelProfilesFile(config.channelsFile, channelProfiles);

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + expiresInMinutes * 60 * 1000);
  const request: TelegramAuthorizationRequest = {
    profileId: config.defaultChannelProfileId,
    code: randomCode(),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  await saveChannelAccessFile(config.channelAccessFile, {
    telegramAuthorization: request
  });
  return request;
}

export async function authorizeTelegramUserFromCode(
  config: AppConfig,
  code: string,
  userId: number
): Promise<{ ok: true; profileId: string } | { ok: false; reason: string }> {
  const access = loadChannelAccessFile(config.channelAccessFile);
  const request = access.telegramAuthorization;
  if (!request) {
    return { ok: false, reason: "No pending authorization request." };
  }
  if (request.code !== code.trim().toUpperCase()) {
    return { ok: false, reason: "Authorization code is invalid." };
  }
  if (Date.parse(request.expiresAt) <= Date.now()) {
    await saveChannelAccessFile(config.channelAccessFile, {});
    return { ok: false, reason: "Authorization code has expired." };
  }

  const channelProfiles = loadChannelProfilesFile(config.channelsFile);
  const profile = channelProfiles.profiles[request.profileId];
  if (!profile || profile.kind !== "telegram") {
    return { ok: false, reason: "Authorization target profile no longer exists." };
  }

  const allowedUserIds = new Set(profile.allowedUserIds ?? []);
  allowedUserIds.add(userId);
  channelProfiles.profiles[request.profileId] = {
    ...profile,
    whitelistEnabled: true,
    allowedUserIds: [...allowedUserIds].sort((a, b) => a - b)
  };

  await saveChannelProfilesFile(config.channelsFile, channelProfiles);
  await saveChannelAccessFile(config.channelAccessFile, {});
  return { ok: true, profileId: request.profileId };
}

export function formatAuthorizationInstruction(request: TelegramAuthorizationRequest): string {
  return [
    "Telegram user authorization is waiting.",
    `Code: ${request.code}`,
    `Expires: ${request.expiresAt}`,
    "",
    "From the Telegram account you want to allow, send this exact message to the bot:",
    `/authorize ${request.code}`
  ].join("\n");
}
