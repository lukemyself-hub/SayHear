/**
 * Candidate Review Portal fixed outcome copy (SPEC #193 §8.5, B2).
 *
 * The Portal maps each fixed typed code to natural language. Model-generated
 * error explanations are never surfaced: unknown codes fall back to a generic
 * message and the raw detail is never rendered.
 */

export const CANDIDATE_REVIEW_OUTCOME_COPY: Readonly<
  Record<string, string>
> = {
  applied: "已提交，并已按真实状态重绘。",
  already_canceled: "该 Proposal 已取消，无需重复操作。",
  already_disposed: "该 Candidate 已被他人或此前操作处置，已显示最新状态。",
  candidate_not_found: "未找到该 Candidate（可能已被清理或不属于当前 Owner）。",
  invalid_reason_code: "拒绝理由或 Proposal 组合无效，未处置。",
  linked_proposal_rejected: "关联 Proposal 当前为已拒绝，需先经 Proposal 层重新考虑。",
  predicate_deprecated: "所选 Predicate 已废弃，请选择当前 active Predicate。",
  predicate_not_active: "所选 Predicate 不在当前 Registry active 集合中，未处置。",
  proposal_draft_rejected: "治理草案未通过 hygiene 检查（重写/attestation/无私人内容/长度），未处置。",
  proposal_not_awaiting_release: "所选 Proposal 当前不在 awaiting_release，无法关联。",
  proposal_not_found: "未找到所选 Proposal。",
  proposal_not_rejected: "所选 Proposal 当前不是已拒绝的产品价值判断，无法以该路径处理。",
  reconsideration_blocked_by_rejected_version: "当前 Proposal 版本为已拒绝，需经合法 superseding 版本解除后方可使用。",
  recent_step_up_required: "需要 10 分钟内的 step-up，请重新验证后重试。",
  review_deadline_passed: "已超过 30 日审查期限，命令已 fail closed，未处置。",
  step_up_required: "缺少 candidate_review 能力或 step-up，请先完成授权。",
  unauthorized: "未登录或无 Internal Owner 会话，请先登录。",
  value_schema_mismatch: "所选 Predicate 的 value schema 与该 Candidate 不匹配，未处置。",
};

export function candidateReviewOutcomeCopy(code: string): string {
  return (
    CANDIDATE_REVIEW_OUTCOME_COPY[code] ??
    "操作未能完成（未知结果码），已显示最新真实状态。"
  );
}

export const CANDIDATE_REVIEW_STAGE_COPY: Readonly<Record<string, string>> = {
  awaiting_release: "等待发布（90 日）",
  needs_review: "待审查（30 日）",
  successor: "后继（实质新证据）",
  terminal_grace: "终态宽限（7 日排错）",
};

export function candidateReviewStageCopy(stage: string): string {
  return CANDIDATE_REVIEW_STAGE_COPY[stage] ?? stage;
}
