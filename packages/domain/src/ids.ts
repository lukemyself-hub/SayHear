declare const userIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: "UserId" };

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asUserId(value: string): UserId {
  if (!uuidV7Pattern.test(value)) {
    throw new Error("UserId must be an opaque UUIDv7.");
  }
  return value as UserId;
}
