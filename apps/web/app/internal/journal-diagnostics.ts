import type {
  JournalDiagnosticFinding,
  JournalGenerationNotice,
} from "@sayhear/application";

export function describeJournalFinding(finding: JournalDiagnosticFinding): string {
  switch (`${finding.code}:${finding.detailCode}`) {
    case "third_person_style:first_person_expression":
      return "可能偏离第三人称观察视角：当前 Statement 中出现了可能的第一人称表达。";
    case "evidence_grounding:evidence_support_unclear":
      return "Evidence 支持关系可能不够清晰：当前 Statement 的表达与所引用内容之间的对应关系需要复核。";
    case "narrative_safety:diagnosis_or_treatment_language":
      return "可能包含诊断或治疗性表达：当前 Statement 可能超出了对用户经历的观察描述。";
    case "narrative_safety:prescriptive_language":
      return "可能包含建议或指令性表达：当前 Statement 可能带有不必要的处方式语气。";
    case "certainty_or_agreement:certainty_language":
      return "可能存在过度确定的表达：当前 Statement 可能把有限 Evidence 表达成了确定结论。";
    case "certainty_or_agreement:agreement_language":
      return "可能存在未经审视的赞同表达：当前 Statement 可能直接认可了对话中的判断。";
    default:
      return "这条 Statement 有一项需要复核的表达诊断。";
  }
}

export function describeJournalGenerationNotice(notice: JournalGenerationNotice): string {
  switch (notice.failureCode) {
    case "invalid_schema":
      return `${notice.logicalDate} 的 Journal 未生成：模型返回的内容结构无法校验。`;
    case "missing_evidence":
    case "invalid_evidence":
      return `${notice.logicalDate} 的 Journal 未生成：Statement 没有通过 Evidence 来源校验。`;
    case "empty_journal":
      return `${notice.logicalDate} 的 Journal 未生成：模型没有返回可发布的 Statement。`;
    default:
      return `${notice.logicalDate} 的 Journal 未生成：内容没有通过可公开复核的发布校验。`;
  }
}
