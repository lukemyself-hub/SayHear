import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PURGE_SURFACE_REGISTRY_SNAPSHOT,
  normalizePurgeSurfaceConstraintDefinition,
  validatePurgeSurfaceInventory,
  type PurgeSurfaceSchemaInventory,
} from "@sayhear/application";
import {
  RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST,
} from "@sayhear/ai";
import { assertPurgeSurfaceAdapterCoverage as assertDataAdapterCoverage } from "@sayhear/data";

type ParsedTable = Readonly<{ name: string; body: string }>;
type ParsedAlter = Readonly<{ name: string; body: string }>;
type ParsedForeignKey = Readonly<{
  childTable: string;
  constraintName: string | null;
  parentTable: string;
  relation: string;
  canonical: string;
  order: number;
}>;
type DroppedConstraint = Readonly<{
  childTable: string;
  constraintName: string;
  order: number;
}>;
type ParsedConstraint = Readonly<{
  canonical: string;
  constraintName: string | null;
  order: number;
  table: string;
}>;

const migrationsDirectory = join(process.cwd(), "packages/data/migrations");
const ownerRootTables = new Set([
  "app_users",
  "workflow_commands",
  "outbox_events",
  "owner_purge_orders",
  "owner_purge_receipts",
]);
// Keep this manifest independent from the registry and the runtime adapter.
// A new provider integration must update all three coverage declarations before
// it can pass the release gate.
const STATIC_EXTERNAL_INTEGRATION_MANIFEST_VERSION =
  "purge-external-integration-manifest:v1";
const STATIC_EXTERNAL_INTEGRATION_IDS = [
  "provider-egress.responses-api",
] as const;

function assertExecutableExternalManifestCoverage(): void {
  const executableIds =
    RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST.integrationIds;
  if (
    RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST.version !==
      STATIC_EXTERNAL_INTEGRATION_MANIFEST_VERSION ||
    executableIds.length !== STATIC_EXTERNAL_INTEGRATION_IDS.length ||
    executableIds.some(
      (integrationId) => !STATIC_EXTERNAL_INTEGRATION_IDS.includes(integrationId),
    )
  ) {
    throw new Error(
      "Purge Surface Registry external manifest does not match the executable provider-egress manifest.",
    );
  }
}

const tablePattern =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi;
const indexPattern =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\s+ON\s+([a-z][a-z0-9_]*)\s*([\s\S]*?);/gi;
const alterTablePattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z][a-z0-9_]*)\s+([\s\S]*?);/gi;
const dropTablePattern =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z][a-z0-9_]*)/gi;
const dropIndexPattern =
  /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-z][a-z0-9_]*)/gi;
const dropConstraintPattern =
  /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-z][a-z0-9_]*)/gi;
const createTableStatementPattern = /CREATE\s+TABLE\b/gi;
const createIndexStatementPattern =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const alterTableStatementPattern = /ALTER\s+TABLE\b/gi;

function inferForeignKeyConstraintName(
  table: string,
  body: string,
  referenceIndex: number,
): string | null {
  const beforeReference = body.slice(0, referenceIndex);
  const explicit = beforeReference.match(
    /\b(?:ADD\s+)?CONSTRAINT\s+([a-z][a-z0-9_]*)\b/gi,
  );
  if (explicit && explicit.length > 0) {
    const last = explicit.at(-1);
    const name = last?.match(
      /\b(?:ADD\s+)?CONSTRAINT\s+([a-z][a-z0-9_]*)\b/i,
    )?.[1];
    if (name) {
      return name;
    }
  }

  // PostgreSQL names an unnamed FK after its table and all referencing
  // columns. This covers both table-level FOREIGN KEY declarations and the
  // inline `column ... REFERENCES ...` form used by these migrations.
  const tableLevel = [...beforeReference.matchAll(
    /\bFOREIGN\s+KEY\s*\(\s*([^)]*)\)/gi,
  )].at(-1)?.[1];
  if (tableLevel) {
    const columns = tableLevel
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    if (columns.length > 0) {
      return `${table}_${columns.join("_")}_fkey`.slice(0, 63);
    }
  }
  const column = beforeReference
    .slice(beforeReference.lastIndexOf(",") + 1)
    .match(/^\s*(?:ADD\s+(?:COLUMN\s+)?)?([a-z][a-z0-9_]*)\s+/i)?.[1];
  return column ? `${table}_${column}_fkey` : null;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toUpperCase();
}

function postgresGeneratedConstraintName(
  table: string,
  columns: string[],
  suffix: "pkey" | "key",
): string {
  return `${table}_${columns.join("_")}_${suffix}`.slice(0, 63);
}

function constraintDefinitions(
  table: string,
  body: string,
  order: number,
): ParsedConstraint[] {
  const constraints: ParsedConstraint[] = [];
  let unnamedTableCheckIndex = 0;
  for (const definition of splitSqlDefinitions(body)) {
    const trimmed = definition.trim();
    const explicitName = trimmed.match(
      /^CONSTRAINT\s+([a-z][a-z0-9_]*)\s+/i,
    )?.[1] ?? null;
    const unprefixed = trimmed.replace(
      /^CONSTRAINT\s+[a-z][a-z0-9_]*\s+/i,
      "",
    );
    const tableLevel = trimmed.match(
      /^(?:CONSTRAINT\s+[a-z][a-z0-9_]*\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)/i,
    );
    if (tableLevel) {
      const kind = normalizeSql(tableLevel[1]);
      const columns = tableLevel[2]
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);
      constraints.push({
        canonical: `${table}|${normalizeSql(`${kind} (${columns.join(", ")})`)}`,
        constraintName:
          explicitName ??
          postgresGeneratedConstraintName(
            table,
            columns,
            kind === "PRIMARY KEY" ? "pkey" : "key",
          ),
        order,
        table,
      });
      continue;
    }
    const tableLevelKind = unprefixed.match(/^(CHECK|EXCLUDE)\b/i)?.[1];
    if (tableLevelKind) {
      const normalizedKind = tableLevelKind.toUpperCase();
      const unnamedName = `${table}_${normalizedKind === "CHECK" ? "check" : "exclude"}${unnamedTableCheckIndex > 0 ? unnamedTableCheckIndex : ""}`;
      unnamedTableCheckIndex += 1;
      constraints.push({
        canonical: `${table}|${normalizePurgeSurfaceConstraintDefinition(unprefixed)}`,
        constraintName: explicitName ?? unnamedName,
        order,
        table,
      });
      continue;
    }
    const column = trimmed.match(/^([a-z][a-z0-9_]*)\b/i)?.[1];
    if (!column) {
      continue;
    }
    if (/\bPRIMARY\s+KEY\b/i.test(trimmed)) {
      constraints.push({
        canonical: `${table}|${normalizeSql(`PRIMARY KEY (${column})`)}`,
        constraintName: explicitName ?? `${table}_pkey`.slice(0, 63),
        order,
        table,
      });
    } else if (/\bUNIQUE\b/i.test(trimmed)) {
      constraints.push({
        canonical: `${table}|${normalizeSql(`UNIQUE (${column})`)}`,
        constraintName:
          explicitName ?? postgresGeneratedConstraintName(table, [column], "key"),
        order,
        table,
      });
    }
    const checkCount = [...trimmed.matchAll(/\bCHECK\s*\(/gi)].length;
    const checkStart = trimmed.search(/\bCHECK\s*\(/i);
    for (let index = 0; index < checkCount; index += 1) {
      constraints.push({
        canonical: `${table}|${normalizePurgeSurfaceConstraintDefinition(
          trimmed.slice(checkStart >= 0 ? checkStart : 0),
        )}`,
        constraintName:
          explicitName ??
          `${table}_${column}_check${index > 0 ? index : ""}`,
        order: order + index,
        table,
      });
    }
  }
  return constraints;
}

function alterConstraintDefinitions(
  table: string,
  body: string,
  order: number,
): ParsedConstraint[] {
  const constraints: ParsedConstraint[] = [];
  for (const match of body.matchAll(
    /ADD\s+(?:CONSTRAINT\s+([a-z][a-z0-9_]*)\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)/gi,
  )) {
    const kind = normalizeSql(match[2] ?? "");
    const columns = (match[3] ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    constraints.push({
      canonical: `${table}|${normalizeSql(`${kind} (${columns.join(", ")})`)}`,
      constraintName:
        match[1] ??
        postgresGeneratedConstraintName(
          table,
          columns,
          kind === "PRIMARY KEY" ? "pkey" : "key",
        ),
      order: order + (match.index ?? 0),
      table,
    });
  }
  for (const { definition, start } of splitSqlDefinitionsWithPositions(body)) {
    const addedConstraint = definition.trim().match(
      /^ADD\s+(?:CONSTRAINT\s+([a-z][a-z0-9_]*)\s+)?(CHECK|EXCLUDE)\b[\s\S]*$/i,
    );
    if (addedConstraint) {
      constraints.push({
        canonical: `${table}|${normalizePurgeSurfaceConstraintDefinition(
          definition,
        )}`,
        constraintName: addedConstraint[1] ?? null,
        order: order + start,
        table,
      });
      continue;
    }
    const addedColumn = definition.trim().match(
      /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\b([\s\S]*)$/i,
    );
    if (!addedColumn) {
      continue;
    }
    const column = addedColumn[1] ?? "";
    const columnDefinition = addedColumn[2] ?? "";
    const explicitName = columnDefinition.match(
      /\bCONSTRAINT\s+([a-z][a-z0-9_]*)\s+CHECK\b/i,
    )?.[1];
    const checkCount = [...columnDefinition.matchAll(/\bCHECK\s*\(/gi)].length;
    for (let index = 0; index < checkCount; index += 1) {
      const checkStart = columnDefinition.search(/\bCHECK\s*\(/i);
      constraints.push({
        canonical: `${table}|${normalizePurgeSurfaceConstraintDefinition(
          columnDefinition.slice(checkStart >= 0 ? checkStart : 0),
        )}`,
        constraintName:
          explicitName ??
          `${table}_${column}_check${index > 0 ? index : ""}`,
        order: order + start + index,
        table,
      });
    }
  }
  return constraints;
}

function foreignKeyCanonical(
  table: string,
  body: string,
  referenceIndex: number,
  parentTable: string,
): string {
  const beforeReference = body.slice(0, referenceIndex);
  const tableLevelColumns = [...beforeReference.matchAll(
    /\bFOREIGN\s+KEY\s*\(([^)]*)\)/gi,
  )].at(-1)?.[1];
  const inlineColumn = beforeReference
    .slice(beforeReference.lastIndexOf(",") + 1)
    .match(/^\s*(?:ADD\s+(?:COLUMN\s+)?)?([a-z][a-z0-9_]*)\s+/i)?.[1];
  const childColumns = (tableLevelColumns ?? inlineColumn ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .join(", ");
  const referenceTail = body.slice(referenceIndex);
  const reference = referenceTail.match(
    /^REFERENCES\s+[a-z][a-z0-9_]*(?:\s*\(([^)]*)\))?/i,
  );
  const parentColumns = (reference?.[1] ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .join(", ");
  const referenceEnd = reference?.[0].length ?? 0;
  const options = referenceTail
    .slice(referenceEnd)
    .match(
      /^(?:\s+(?:MATCH\s+(?:FULL|PARTIAL|SIMPLE)|ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)|(?:NOT\s+)?DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|NOT\s+VALID))*/i,
    )?.[0]
    ?.trim();
  const definition = [
    `FOREIGN KEY (${childColumns})`,
    `REFERENCES ${parentTable}${parentColumns ? `(${parentColumns})` : ""}`,
    options,
  ]
    .filter(Boolean)
    .join(" ");
  return `${table}|${normalizeSql(definition)}`;
}

function splitSqlDefinitions(body: string): string[] {
  return splitSqlDefinitionsWithPositions(body).map(({ definition }) => definition);
}

function splitSqlDefinitionsWithPositions(
  body: string,
): ReadonlyArray<Readonly<{ definition: string; start: number }>> {
  const definitions: string[] = [];
  const positions: number[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      if (character === quote && body[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      definitions.push(body.slice(start, index));
      positions.push(start);
      start = index + 1;
    }
  }
  definitions.push(body.slice(start));
  positions.push(start);
  return definitions.map((definition, index) => ({
    definition,
    start: positions[index] ?? 0,
  }));
}

function tableColumns(table: string, body: string): string[] {
  return splitSqlDefinitions(body)
    .map((definition) => definition.trim().match(/^([a-z][a-z0-9_]*)\b/i)?.[1])
    .filter(
      (column): column is string =>
        column !== undefined &&
        ![
          "constraint",
          "primary",
          "unique",
          "check",
          "foreign",
          "exclude",
        ].includes(column.toLowerCase()),
    )
    .map((column) => `${table}.${column}`);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

async function main(): Promise<void> {
  assertExecutableExternalManifestCoverage();
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const sources = await Promise.all(
    migrationNames.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDirectory, name), "utf8"),
    })),
  );

  const tables = new Map<string, ParsedTable>();
  const alters: ParsedAlter[] = [];
  const indexes = new Map<
    string,
    { name: string; table: string; definition: string }
  >();
  const columns = new Map<string, Set<string>>();
  const foreignKeys: ParsedForeignKey[] = [];
  const droppedConstraints: DroppedConstraint[] = [];
  const constraints: ParsedConstraint[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const sql = stripSqlComments(source.sql);
    const tableStatements = [...sql.matchAll(createTableStatementPattern)];
    const tableMatches = [...sql.matchAll(tablePattern)];
    if (tableStatements.length !== tableMatches.length) {
      throw new Error(
        `Purge Surface Registry inventory cannot parse every CREATE TABLE in ${source.name}.`,
      );
    }
    const indexStatements = [...sql.matchAll(createIndexStatementPattern)];
    const indexMatches = [...sql.matchAll(indexPattern)];
    if (indexStatements.length !== indexMatches.length) {
      throw new Error(
        `Purge Surface Registry inventory cannot parse every CREATE INDEX in ${source.name}.`,
      );
    }
    const alterStatements = [...sql.matchAll(alterTableStatementPattern)];
    const alterMatches = [...sql.matchAll(alterTablePattern)];
    if (alterStatements.length !== alterMatches.length) {
      throw new Error(
        `Purge Surface Registry inventory cannot parse every ALTER TABLE in ${source.name}.`,
      );
    }
    const tableOperations = [
      ...tableMatches.map((match) => ({
        body: match[2] ?? "",
        index: match.index ?? 0,
        kind: "create" as const,
        name: match[1] ?? "",
      })),
      ...[...sql.matchAll(dropTablePattern)].map((match) => ({
        body: "",
        index: match.index ?? 0,
        kind: "drop" as const,
        name: match[1] ?? "",
      })),
    ].sort((left, right) => left.index - right.index);
    for (const operation of tableOperations) {
      if (operation.kind === "drop") {
        tables.delete(operation.name);
        columns.delete(operation.name);
        continue;
      }
      const { body, name } = operation;
      if (name && body) {
        tables.set(name, { body, name });
        columns.set(name, new Set(tableColumns(name, body)));
        constraints.push(
          ...constraintDefinitions(name, body, sourceIndex * 1_000_000 + operation.index),
        );
        for (const reference of body.matchAll(
          /REFERENCES\s+([a-z][a-z0-9_]*)/gi,
        )) {
          if (reference[1]) {
            const relation = `${name}->${reference[1]}`;
            foreignKeys.push({
              canonical: foreignKeyCanonical(
                name,
                body,
                reference.index ?? 0,
                reference[1],
              ),
              childTable: name,
              constraintName: inferForeignKeyConstraintName(
                name,
                body,
                reference.index ?? 0,
              ),
              parentTable: reference[1],
              relation,
              order:
                sourceIndex * 1_000_000 +
                operation.index +
                (reference.index ?? 0),
            });
          }
        }
      }
    }
    const indexOperations = [
      ...indexMatches.map((match) => ({
        index: match.index ?? 0,
        kind: "create" as const,
        definition: match[0] ?? "",
        name: match[1] ?? "",
        table: match[2] ?? "",
      })),
      ...[...sql.matchAll(dropIndexPattern)].map((match) => ({
        definition: "",
        index: match.index ?? 0,
        kind: "drop" as const,
        name: match[1] ?? "",
        table: "",
      })),
    ].sort((left, right) => left.index - right.index);
    for (const operation of indexOperations) {
      if (operation.kind === "drop") {
        indexes.delete(operation.name);
      } else if (operation.name && operation.table) {
        indexes.set(operation.name, {
          definition: operation.definition,
          name: operation.name,
          table: operation.table,
        });
      }
    }
    for (const match of alterMatches) {
      const name = match[1];
      const body = match[2];
      if (name && body) {
        alters.push({ body, name });
        constraints.push(
          ...alterConstraintDefinitions(
            name,
            body,
            sourceIndex * 1_000_000 + (match.index ?? 0),
          ),
        );
        const columnOperations = [
          ...[...body.matchAll(
            /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)/gi,
          )].map((column) => ({
            column: column[1] ?? "",
            index: column.index ?? 0,
            kind: "add" as const,
          })),
          ...[...body.matchAll(
            /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z][a-z0-9_]*)/gi,
          )].map((column) => ({
            column: column[1] ?? "",
            index: column.index ?? 0,
            kind: "drop" as const,
          })),
        ].sort((left, right) => left.index - right.index);
        const tableColumnSet = columns.get(name) ?? new Set<string>();
        for (const operation of columnOperations) {
          if (!operation.column) {
            continue;
          }
          const key = `${name}.${operation.column}`;
          if (operation.kind === "add") {
            tableColumnSet.add(key);
          } else {
            tableColumnSet.delete(key);
          }
        }
        columns.set(name, tableColumnSet);
        for (const dropped of body.matchAll(dropConstraintPattern)) {
          if (dropped[1]) {
            droppedConstraints.push({
              childTable: name,
              constraintName: dropped[1],
              order:
                sourceIndex * 1_000_000 +
                (match.index ?? 0) +
                (dropped.index ?? 0),
            });
          }
        }
        for (const reference of body.matchAll(
          /REFERENCES\s+([a-z][a-z0-9_]*)/gi,
        )) {
          if (reference[1]) {
            const relation = `${name}->${reference[1]}`;
            foreignKeys.push({
              canonical: foreignKeyCanonical(
                name,
                body,
                reference.index ?? 0,
                reference[1],
              ),
              childTable: name,
              constraintName: inferForeignKeyConstraintName(
                name,
                body,
                reference.index ?? 0,
              ),
              parentTable: reference[1],
              relation,
              order: sourceIndex * 1_000_000 + (match.index ?? 0) + (reference.index ?? 0),
            });
          }
        }
      }
    }
  }

  // Drop operations are part of the final schema shape. Apply them after the
  // migration walk so a dropped table/index or named FK cannot leave a stale
  // registry object in the release manifest.
  const activeTables = new Set(tables.keys());
  const activeForeignKeys = foreignKeys.filter(
    (foreignKey) => {
      if (
        !activeTables.has(foreignKey.childTable) ||
        !activeTables.has(foreignKey.parentTable)
      ) {
        return false;
      }
      if (foreignKey.constraintName === null) {
        return true;
      }
      const latestDrop = droppedConstraints
        .filter(
          (constraint) =>
            constraint.childTable === foreignKey.childTable &&
            constraint.constraintName === foreignKey.constraintName,
        )
        .sort((left, right) => right.order - left.order)[0];
      return latestDrop === undefined || foreignKey.order > latestDrop.order;
    },
  );

  /*
   * The remaining entries are historical anonymous/dynamic drops whose
   * generated PostgreSQL names are not present as literals in the migration
   * source. Keep these explicit final-shape removals until the migration set
   * is rewritten with named constraints; a new relation still changes the
   * fingerprint and therefore cannot pass silently.
   */
  const intentionallyRemovedForeignKeys = new Map([
    ["conversation_event_revisions->conversation_events", 1],
  ]);
  const remainingForeignKeys = activeForeignKeys.map(
    (foreignKey) => foreignKey,
  );
  for (const [foreignKey, removalCount] of intentionallyRemovedForeignKeys) {
    for (let index = 0; index < removalCount; index += 1) {
      const position = remainingForeignKeys.findIndex(
        (candidate) => candidate.relation === foreignKey,
      );
      if (position >= 0) {
        remainingForeignKeys.splice(position, 1);
      }
    }
  }
  const activeConstraints = constraints.filter((constraint) => {
    if (!activeTables.has(constraint.table)) {
      return false;
    }
    if (constraint.constraintName === null) {
      return true;
    }
    const latestDrop = droppedConstraints
      .filter(
        (dropped) =>
          dropped.childTable === constraint.table &&
          dropped.constraintName === constraint.constraintName,
      )
      .sort((left, right) => right.order - left.order)[0];
      return latestDrop === undefined || constraint.order > latestDrop.order;
  });
  const intentionallyRemovedConstraints = new Map([
    [
      "workflow_commands|UNIQUE (COMMAND_TYPE, SUBJECT_TYPE, SUBJECT_ID, SOURCE_REVISION, POLICY_VERSION)",
      1,
    ],
    [
      "dialogue_state_commands|UNIQUE (DAILY_SESSION_ID, SOURCE_REVISION, DIALOGUE_REVISION, POLICY_VERSION)",
      1,
    ],
    [
      "journal_generation_commands|UNIQUE (USER_ID, DAILY_SESSION_ID, SOURCE_REVISION, GENERATION_POLICY_VERSION)",
      1,
    ],
    [
      "journal_versions|UNIQUE (JOURNAL_ID, SOURCE_REVISION, GENERATION_POLICY_VERSION)",
      1,
    ],
    [
      "journal_versions|UNIQUE (USER_ID, DAILY_SESSION_ID, SOURCE_REVISION, GENERATION_POLICY_VERSION)",
      1,
    ],
    [
      "journal_statements|UNIQUE (JOURNAL_VERSION_ID, USER_ID, SOURCE_REVISION, EVIDENCE_SOURCE_SNAPSHOT_ID)",
      1,
    ],
    // These checks were replaced by later migrations. Their generated names
    // are not stable source literals, so remove the old definitions by body.
    [
      "outbox_events|CHECK STATUS = 'PENDING' AND LEASE_OWNER IS NULL AND LEASE_EXPIRES_AT IS NULL OR STATUS IN 'LEASED', 'DISPATCHED' AND LEASE_OWNER IS NOT NULL AND LEASE_EXPIRES_AT IS NOT NULL OR STATUS = 'DEAD_LETTERED'",
      1,
    ],
    [
      "memory_candidates|CHECK PREDICATE_RESOLUTION_STATUS = 'MAPPED' AND PREDICATE_ID IS NOT NULL AND PREDICATE_REGISTRY_VERSION IS NOT NULL OR PREDICATE_RESOLUTION_STATUS <> 'MAPPED' AND PREDICATE_ID IS NULL AND PROPOSED_CONCEPT IS NOT NULL",
      1,
    ],
    [
      "journal_statements|CHECK EPISTEMIC_STATUS IN 'SUPPORTED_EXPRESSION', 'INFERRED_OBSERVATION'",
      1,
    ],
  ]);
  const remainingConstraints = [...activeConstraints];
  for (const [constraint, removalCount] of intentionallyRemovedConstraints) {
    for (let index = 0; index < removalCount; index += 1) {
      const position = remainingConstraints.findIndex(
        (candidate) =>
          candidate.canonical === constraint ||
          (constraint.endsWith("|CHECK") &&
            candidate.canonical.startsWith(`${constraint.slice(0, -"|CHECK".length)}|CHECK`)),
      );
      if (position >= 0) {
        remainingConstraints.splice(position, 1);
      }
    }
  }
  const ownerTables = new Set(ownerRootTables);
  for (const table of tables.values()) {
    if (/\buser_id\b/i.test(table.body)) {
      ownerTables.add(table.name);
    }
  }

  // Ownership can be introduced after CREATE TABLE by a later migration.
  // Include those ALTER TABLE statements in the same inventory so a new
  // owner_id column or owner foreign key cannot bypass the gate.
  const ownershipReferences = new Map<string, Set<string>>();
  for (const alter of alters) {
    if (/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?user_id\b/i.test(alter.body)) {
      ownerTables.add(alter.name);
    }
    const references = new Set<string>();
    for (const match of alter.body.matchAll(
      /REFERENCES\s+([a-z][a-z0-9_]*)/gi,
    )) {
      if (match[1]) {
        references.add(match[1]);
      }
    }
    if (references.size > 0) {
      ownershipReferences.set(alter.name, references);
    }
  }

  // Child tables without a direct user_id are owner-scoped when their foreign
  // key points to an already owner-scoped table. Iterate to a fixed point so a
  // new private child of a private child is also enumerated automatically.
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables.values()) {
      if (ownerTables.has(table.name)) {
        continue;
      }
      const referencesOwnerTable = [
        ...table.body.matchAll(/REFERENCES\s+([a-z][a-z0-9_]*)/gi),
      ].some((match) => match[1] && ownerTables.has(match[1]));
      if (referencesOwnerTable) {
        ownerTables.add(table.name);
        changed = true;
      }
      const referencesFromAlter = ownershipReferences.get(table.name);
      if (
        referencesFromAlter &&
        [...referencesFromAlter].some((reference) => ownerTables.has(reference))
      ) {
        ownerTables.add(table.name);
        changed = true;
      }
    }
  }
  const inventory: PurgeSurfaceSchemaInventory = {
    columns: [...columns.entries()]
      .filter(([table]) => ownerTables.has(table))
      .flatMap(([, tableColumns]) => [...tableColumns])
      .sort(),
    constraints: remainingConstraints
      .filter((constraint) => ownerTables.has(constraint.table))
      .map((constraint) => constraint.canonical)
      .sort(),
    foreignKeys: remainingForeignKeys
      .map((foreignKey) => foreignKey.canonical)
      .sort(),
    indexes: [...indexes.values()]
      .filter((index) => ownerTables.has(index.table))
      .sort((left, right) => left.name.localeCompare(right.name)),
    tables: [...ownerTables].sort(),
    externalIntegrationManifestVersion:
      STATIC_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
    externalIntegrations: [...STATIC_EXTERNAL_INTEGRATION_IDS],
  };
  // Run the data-layer adapter coverage gate as part of the release check as
  // well as at runtime. Unsupported clear/verify handlers must fail before a
  // migration can be promoted, not only when the first purge starts.
  assertDataAdapterCoverage(PURGE_SURFACE_REGISTRY_SNAPSHOT);
  if (process.env.DUMP_INVENTORY === "1") {
    process.stdout.write(
      "CONSTRAINTS:" + JSON.stringify(inventory.constraints) + "\n",
    );
  }
  const result = validatePurgeSurfaceInventory(inventory);
  if (!result.ok) {
    console.error("Purge Surface Registry inventory check failed.");
    if (result.missingTables.length > 0) {
      console.error(`Missing table registrations: ${result.missingTables.join(", ")}`);
    }
    if (result.missingIndexes.length > 0) {
      console.error(`Missing index registrations: ${result.missingIndexes.join(", ")}`);
    }
    if (result.missingExternalIntegrations.length > 0) {
      console.error(
        `Missing external registrations: ${result.missingExternalIntegrations.join(", ")}`,
      );
    }
    if (result.registryExternalIntegrationsMissingFromInventory.length > 0) {
      console.error(
        `Registered external integrations missing from inventory: ${result.registryExternalIntegrationsMissingFromInventory.join(", ")}`,
      );
    }
    if (result.indexTableMismatches.length > 0) {
      console.error(
        `Registered indexes attached to a different table: ${result.indexTableMismatches
          .map((mismatch) => `${mismatch.name} (${mismatch.registeredTable} != ${mismatch.inventoryTable})`)
          .join(", ")}`,
      );
    }
    if (result.registryObjectsMissingFromSchema.length > 0) {
      console.error(
        `Registry objects missing from migrations: ${result.registryObjectsMissingFromSchema.join(", ")}`,
      );
    }
    if (result.registryColumnsMissingFromSchema.length > 0) {
      console.error(
        `Registry columns missing from migrations: ${result.registryColumnsMissingFromSchema.join(", ")}`,
      );
    }
    if (result.schemaColumnsMissingFromRegistry.length > 0) {
      console.error(
        `Migration columns missing from registry: ${result.schemaColumnsMissingFromRegistry.join(", ")}`,
      );
    }
    if (result.foreignKeyManifestMismatch) {
      console.error(
        `Foreign-key manifest changed: ${result.foreignKeyManifestMismatch.actual} (expected ${result.foreignKeyManifestMismatch.expected}).`,
      );
    }
    if (result.externalIntegrationManifestVersionMismatch) {
      console.error(
        `External integration manifest version changed: ${result.externalIntegrationManifestVersionMismatch.actual} (expected ${result.externalIntegrationManifestVersionMismatch.expected}).`,
      );
    }
    if (result.columnManifestMismatch) {
      console.error(
        `Column manifest changed: ${result.columnManifestMismatch.actual} (expected ${result.columnManifestMismatch.expected}).`,
      );
    }
    if (result.constraintManifestMismatch) {
      console.error(
        `Constraint manifest changed: ${result.constraintManifestMismatch.actual} (expected ${result.constraintManifestMismatch.expected}).`,
      );
    }
    if (result.indexManifestMismatch) {
      console.error(
        `Index manifest changed: ${result.indexManifestMismatch.actual} (expected ${result.indexManifestMismatch.expected}).`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Purge Surface Registry covers ${result.registeredTables.length} tables and ${result.registeredIndexes.length} indexes.`,
    );
  }
}

void main();
