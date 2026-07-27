import {
  createInternalOwnerAccessService,
  createUserTextConversationService,
} from "@sayhear/application";
import {
  createPostgresPool,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
} from "@sayhear/data";

import { createAuthOptions } from "./auth";
import { loadRuntimeConfiguration } from "./runtime-config";

const globalPool = globalThis as typeof globalThis & {
  sayHearPool?: ReturnType<typeof createPostgresPool>;
};

export function createServerComposition() {
  const configuration = loadRuntimeConfiguration(process.env);
  const pool =
    globalPool.sayHearPool ??
    createPostgresPool({
      applicationName: "sayhear-web",
      connectionString: configuration.databaseUrl,
    });

  globalPool.sayHearPool = pool;

  const accessRepository = new PostgresInternalOwnerAccessRepository(pool);
  const conversationRepository =
    new PostgresUserTextConversationRepository(pool);
  return {
    accessService: createInternalOwnerAccessService({
      clock: configuration.clock,
      expectedBackupPolicyVersion: configuration.backupPolicyVersion,
      expectedConfigurationFingerprint:
        configuration.backupConfigurationFingerprint,
      repository: accessRepository,
    }),
    authOptions: createAuthOptions({ configuration, pool }),
    conversationService: createUserTextConversationService({
      clock: configuration.clock,
      expectedBackupPolicyVersion: configuration.backupPolicyVersion,
      expectedConfigurationFingerprint:
        configuration.backupConfigurationFingerprint,
      repository: conversationRepository,
    }),
  };
}
