// 生成一个 UUIDv7，用于本地验证 .env 的 SAYHEAR_INTERNAL_OWNER_USER_ID。
//
// 用法：node scripts/gen-owner-uuid.mjs
//
// 说明：
// - SayHear 用这个值作为 Internal Owner 的稳定 userId。provision-owner 时把它
//   写入数据库，登录时由 GitHub issuer/subject 解引用到这个 id，因此该值在
//   provision 与后续登录之间必须保持一致（生成一次后存进 .env 即可，不要每次换）。
// - 必须是 UUIDv7（不是 v4），因为它内含毫秒级时间戳，使按时间排序天然有序。

import { randomUUIDv7 } from "node:crypto";

console.log(randomUUIDv7());
