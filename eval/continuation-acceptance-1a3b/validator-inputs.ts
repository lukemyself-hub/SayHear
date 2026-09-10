import { readFileSync } from "node:fs";

import { asUserId } from "@sayhear/domain";
import type {
  NarrativeArtifactKind,
  NarrativeGeneratorStatement,
  NarrativeSourceEntry,
  NarrativeValidationRequest,
} from "../../packages/application/src/narrative-validation/types";
import {
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
} from "../../packages/application/src/narrative-validation/types";
import type {
  FixtureCatalog,
  ValidatorFixture,
} from "./protocol";

/**
 * Calibration input seam for ADR-0137 / issue #198 (AC-X03): transforms the
 * frozen 18-case `narrative.validate` dangerous-error set into production
 * validation requests. The generator manifest comes from the producing
 * writer run (the 18 fixtures predate the writer lanes); a run capture that
 * executes the production validation entry supplies it per fixture.
 *
 * This module never fakes a model verdict: it only freezes inputs. Detection
 * quality is judged by Luke's separate adjudication ledger
 * (`validate-ledger.ts`), and results from the two evidence groups cannot
 * offset one another (ADR-0137).
 */

export type ValidatorRequestBundle = Readonly<{
  artifactKind: NarrativeArtifactKind;
  draftRef: string;
  fixtureId: string;
  generatorManifest: readonly NarrativeGeneratorStatement[];
  request: NarrativeValidationRequest;
  validatorErrorClass: string;
}>;

function epistemicKindForClaim(
  claim: { kind: string } | undefined,
): "objective_memory" | "ai_impression" | null {
  if (claim?.kind === "objective_memory") return "objective_memory";
  if (claim?.kind === "ai_impression") return "ai_impression";
  return null;
}

function sourceEntriesForFixture(
  catalog: FixtureCatalog,
  fixture: ValidatorFixture,
): NarrativeSourceEntry[] {
  const sharedInput = catalog.sharedInputs[fixture.inputRef];
  if (!sharedInput) {
    throw new Error(`Validator fixture ${fixture.id} references unknown shared input ${fixture.inputRef}.`);
  }
  const entries: NarrativeSourceEntry[] = [];
  for (const claimId of fixture.sourceClaimIds) {
    const claim = sharedInput.memory.find((candidate) => candidate.id === claimId);
    if (!claim) {
      throw new Error(
        `Validator fixture ${fixture.id} cites unknown source claim ${claimId}.`,
      );
    }
    entries.push({
      sourceKey: claim.id,
      sourceKind: "memory_claim_version",
      text: claim.text,
      epistemicKind: epistemicKindForClaim(claim),
    });
  }
  return entries;
}

export function buildValidatorRequestBundle(
  catalog: FixtureCatalog,
  input: Readonly<{
    /** Generator manifest from the producing writer run, keyed by fixture id. */
    generatorManifests: Readonly<Record<string, readonly NarrativeGeneratorStatement[]>>;
  }>,
): readonly ValidatorRequestBundle[] {
  const fixtures = catalog.scenarios.filter(
    (fixture): fixture is ValidatorFixture => fixture.group === "validator",
  );
  return fixtures.map((fixture) => {
    const draftRef = `validator-fixture:${fixture.id}`;
    const generatorManifest = input.generatorManifests[fixture.id] ?? [];
    const request: NarrativeValidationRequest = {
      userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
      artifactKind: fixture.artifactKind,
      draftRef,
      draftLocale: fixture.locale,
      draftText: fixture.draftText,
      generatorManifest,
      sourceEntries: sourceEntriesForFixture(catalog, fixture),
      // The calibration set treats every cited claim as material: a
      // material_absence fixture is defined by its cited detail being
      // omitted from the draft.
      plannedCoverageKeys: [...fixture.sourceClaimIds],
      validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
      promptVersion:
        fixture.artifactKind === "bio"
          ? NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO
          : NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
      schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
    };
    return {
      artifactKind: fixture.artifactKind,
      draftRef,
      fixtureId: fixture.id,
      generatorManifest,
      request,
      validatorErrorClass: fixture.validatorErrorClass,
    };
  });
}

/** Loads the frozen F3 fixture catalog from the given fixtures.json path. */
export function loadValidatorCatalog(catalogPath: string): FixtureCatalog {
  return JSON.parse(readFileSync(catalogPath, "utf8")) as FixtureCatalog;
}
