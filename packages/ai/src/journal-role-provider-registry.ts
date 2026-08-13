import type {
  EvidenceExtractionProvider,
  EvidenceRole,
  JournalDraft,
  JournalEvidenceReference,
  JournalProviderEgress,
  JournalValidationProvider,
} from "@sayhear/application";
import { asConversationEventRevisionId } from "@sayhear/application";
import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";

export type JournalModelRole = "evidence.extract" | "journal.draft" | "journal.validate";
export type JournalRoleConfiguration = Readonly<{
  role: JournalModelRole;
  provider: "openai" | "deepseek" | "deterministic";
  model: string;
  configVersion: string;
  policyVersion: string;
  promptFingerprint: string;
}>;
type Adapter = Readonly<
  | { type: "deterministic" }
  | { type: "responses-api"; apiKey: string; baseUrl: string; timeoutMs: number }
>;
export type JournalRoleProviderRegistry = Readonly<{
  evidenceExtractor: EvidenceExtractionProvider;
  draft: JournalProviderEgress;
  validator: JournalValidationProvider;
  configuration(role: JournalModelRole): JournalRoleConfiguration;
}>;

/**
 * The sole provider-egress module for Journal roles. Its small interface keeps
 * role selection, prompt fingerprints, and source-text handling out of web,
 * workflow, and persistence callers.
 */
export function createRuntimeJournalRoleProviderRegistry(input: {
  adapter: Adapter;
  roles: readonly [JournalRoleConfiguration, JournalRoleConfiguration, JournalRoleConfiguration];
}): JournalRoleProviderRegistry {
  const configurations = new Map(input.roles.map((role) => [role.role, role]));
  for (const role of ["evidence.extract", "journal.draft", "journal.validate"] as const) {
    const configuration = configurations.get(role);
    if (!configuration || !configuration.model || !configuration.configVersion || !configuration.policyVersion || !configuration.promptFingerprint) {
      throw new Error(`Journal role ${role} requires complete versioned configuration.`);
    }
  }
  const configuration = (role: JournalModelRole) => configurations.get(role)!;
  if (input.adapter.type === "deterministic") {
    return {
      evidenceExtractor: deterministicEvidenceExtractor,
      draft: deterministicJournalDraft,
      validator: deterministicJournalValidator,
      configuration,
    };
  }

  const model = createResponsesApiConversationTextModel(input.adapter);
  const askJson = async (role: JournalModelRole, instructions: string, payload: unknown): Promise<unknown> => {
    let output = "";
    for await (const event of model.stream({
      instructions,
      locale: "en-US",
      model: configuration(role).model,
      messages: [{
        revisionId: asConversationEventRevisionId("00000000-0000-4000-8000-000000000001"),
        role: "user",
        text: JSON.stringify(payload),
      }],
    })) if (event.type === "delta") output += event.delta;
    try { return JSON.parse(output); } catch { throw new Error(`${role} returned non-JSON output.`); }
  };
  return {
    evidenceExtractor: {
      role: "evidence.extract",
      async extract(request) {
        const parsed = await askJson("evidence.extract", "You are SayHear evidence.extract. Return only JSON array of source-grounded spans: [{locatorType:'text_span',locatorKey:'start:end',role:'factual_support'|'subjective_report'}]. Cover each independently meaningful user claim. Never invent text.", request);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("evidence.extract returned no spans.");
        return parsed.map((item) => validateLocator(item, request.sourceText));
      },
    },
    draft: {
      async generate(request) {
        const parsed = await askJson("journal.draft", "You are SayHear journal.draft. Return only JSON matching {locale:string,statements:[{id:string,text:string,epistemicStatus:'supported_expression'|'inferred_observation',evidenceItemIds:string[]}]}. Write third-person Journal statements using only supplied Evidence. Cite every statement. Mark inference with explicit uncertainty.", request);
        if (!isJournalDraft(parsed)) throw new Error("journal.draft returned invalid JSON.");
        return parsed;
      },
    },
    validator: {
      role: "journal.validate",
      async validate(request) {
        const parsed = await askJson("journal.validate", "You are SayHear journal.validate. Return only JSON {valid:boolean,reason?:string}. Reject unsupported facts, insufficient evidence, omitted material evidence, certainty inflation, diagnosis, preaching, blind agreement, or unmarked inference. Accept only evidence-grounded third-person Journal prose.", request);
        if (!isValidationResult(parsed)) throw new Error("journal.validate returned invalid JSON.");
        return parsed;
      },
    },
    configuration,
  };
}

const deterministicEvidenceExtractor: EvidenceExtractionProvider = {
  role: "evidence.extract",
  async extract(input) {
    if (!input.sourceText.trim()) throw new Error("Evidence extractor received empty source text.");
    const spans = [...input.sourceText.matchAll(/\S[\s\S]*?(?:[.!?。！？](?=\s|$)|$)/g)]
      .map((match) => ({ start: match.index ?? 0, text: match[0] }))
      .filter(({ text }) => text.trim().length > 0);
    if (spans.length === 0) throw new Error("Evidence extractor could not locate a textual claim.");
    return spans.map(({ start, text }) => ({ locatorType: "text_span" as const, locatorKey: `${start}:${start + text.length}`, role: "factual_support" as const }));
  },
};

const deterministicJournalDraft: JournalProviderEgress = {
  async generate(input) {
    return {
      locale: input.locale,
      statements: input.evidenceItems.map((item: JournalEvidenceReference) => ({
        id: `statement-${item.id}`,
        text: input.locale.startsWith("zh")
          ? `记录显示，用户分享了：${toThirdPersonSource(input.sourceTextByEvidenceId[item.id] ?? "一段生活经历")}`
          : `The owner described: ${toThirdPersonSource(input.sourceTextByEvidenceId[item.id] ?? "an experience from the day")}`,
        epistemicStatus: "supported_expression" as const,
        evidenceItemIds: [item.id],
      })),
    };
  },
};

function toThirdPersonSource(sourceText: string): string {
  return sourceText
    .replace(/\bI\b/gi, "they")
    .replace(/\b(me|my)\b/gi, "the owner")
    .replace(/\bwe\b/gi, "they")
    .replace(/\bour\b/gi, "the owner's")
    .replace(/我们|我的|我/g, "");
}

const deterministicJournalValidator: JournalValidationProvider = {
  role: "journal.validate",
  async validate({ draft, evidenceItems, sourceTextByEvidenceId }) {
    const evidenceIds = new Set(evidenceItems.map((item) => item.id));
    const citedEvidenceIds = new Set<string>();
    for (const statement of draft.statements) {
      if (statement.evidenceItemIds.length === 0 || statement.evidenceItemIds.some((id) => !evidenceIds.has(id))) return { valid: false, reason: "insufficient_evidence" };
      for (const evidenceId of statement.evidenceItemIds) citedEvidenceIds.add(evidenceId);
      if (/(?:\b(?:diagnos(?:e|is|ed|ing)|therap(?:y|ist)|should|must|you need)\b|诊断|治疗|应该|必须)/i.test(statement.text)) return { valid: false, reason: "unsafe_narrative" };
      if (/(?:\b(?:definitely|always|never|proved|certainly)\b|确实|一定|从不)/i.test(statement.text)) return { valid: false, reason: "certainty_inflation" };
      if (/(?:\b(?:is right|was right|correctly concluded)\b|他说得对|判断正确)/i.test(statement.text)) return { valid: false, reason: "blind_agreement" };
      const supportingText = statement.evidenceItemIds.map((id) => sourceTextByEvidenceId[id] ?? "").join(" ").toLowerCase();
      if (!supportingText.trim()) return { valid: false, reason: "insufficient_evidence" };
      const meaningfulWords = statement.text.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
      if (meaningfulWords.length > 0 && !meaningfulWords.some((word) => supportingText.includes(word))) return { valid: false, reason: "unsupported_fact" };
    }
    if ([...evidenceIds].some((id) => !citedEvidenceIds.has(id))) return { valid: false, reason: "material_evidence_omitted" };
    return { valid: true };
  },
};

function validateLocator(value: unknown, sourceText: string): { locatorType: "text_span"; locatorKey: string; role: EvidenceRole } {
  if (typeof value !== "object" || value === null) throw new Error("evidence.extract returned an invalid locator.");
  const candidate = value as { locatorType?: unknown; locatorKey?: unknown; role?: unknown };
  if (candidate.locatorType !== "text_span" || typeof candidate.locatorKey !== "string" || !["factual_support", "subjective_report"].includes(String(candidate.role))) throw new Error("evidence.extract returned an invalid locator.");
  const match = /^(\d+):(\d+)$/.exec(candidate.locatorKey);
  if (!match || Number(match[1]) >= Number(match[2]) || Number(match[2]) > sourceText.length || !sourceText.slice(Number(match[1]), Number(match[2])).trim()) throw new Error("evidence.extract returned an out-of-range locator.");
  return { locatorType: "text_span", locatorKey: candidate.locatorKey, role: candidate.role as EvidenceRole };
}

function isJournalDraft(value: unknown): value is JournalDraft {
  return typeof value === "object" && value !== null && typeof (value as { locale?: unknown }).locale === "string" && Array.isArray((value as { statements?: unknown }).statements);
}

function isValidationResult(value: unknown): value is { valid: true } | { valid: false; reason: string } {
  return typeof value === "object" && value !== null && typeof (value as { valid?: unknown }).valid === "boolean" && ((value as { valid: boolean; reason?: unknown }).valid || typeof (value as { reason?: unknown }).reason === "string");
}
