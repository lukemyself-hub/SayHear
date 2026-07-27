import { randomBytes } from "node:crypto";

export function createUuidV7(now: Date): string {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error("UUIDv7 timestamp is outside the supported range.");
  }

  const bytes = randomBytes(16);
  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp & 0xff;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
