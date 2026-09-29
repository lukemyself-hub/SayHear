import { describe, expect, it } from "vitest";

import {
  classifyConversationTurnSignal,
  containsAbsoluteConfidentiality,
  containsDiagnosis,
  containsTherapistImpersonation,
  containsUnconditionalAgreement,
  containsUnsolicitedAdvice,
  countFollowUpQuestions,
  detectMinimumHighRiskSignal,
  MINIMUM_HIGH_RISK_RESPONSE_POLICY_VERSION,
  renderMinimumHighRiskResponse,
  resolveConversationLocale,
  validateMinimumHighRiskResponse,
  validateUnderstandingResponse,
} from "./conversation-behavior";
import { listSafetyResourceNumbers } from "./safety-resources";

describe("conversation behavior locale resolution", () => {
  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh-Hans", "zh"],
    ["zh-TW", "zh"],
  ])("maps the BCP-47 tag %s to the supported locale %s", (tag, expected) => {
    expect(resolveConversationLocale(tag)).toBe(expected);
  });

  it("falls back to English for an unsupported locale rather than refusing the owner", () => {
    expect(resolveConversationLocale("ja-JP")).toBe("en");
  });
});

describe("minimum high-risk signal detection", () => {
  it("records the versioned safety policy on every classification", () => {
    expect(detectMinimumHighRiskSignal({ locale: "en", text: "I am fine." }))
      .toMatchObject({
        kind: null,
        policyVersion: MINIMUM_HIGH_RISK_RESPONSE_POLICY_VERSION,
      });
  });

  it.each([
    ["self-harm (en)", "en", "I want to kill myself tonight."],
    ["self-harm (en)", "en", "I am going to end my life."],
    ["self-harm (en)", "en", "I keep thinking about suicide."],
    ["self-harm (zh)", "zh-CN", "我不想活了，真的撑不下去了。"],
    ["self-harm (zh)", "zh-Hans", "我想结束自己的生命。"],
    ["self-harm (zh)", "zh-CN", "我一直在想自杀的事。"],
  ])("classifies an explicit %s signal as self-harm", (_label, locale, text) => {
    expect(detectMinimumHighRiskSignal({ locale, text }).kind).toBe(
      "self_harm",
    );
  });

  it.each([
    ["harm-to-others (en)", "en", "I want to hurt someone close to me."],
    ["harm-to-others (en)", "en", "I am going to kill him."],
    ["harm-to-others (zh)", "zh-CN", "我想伤害别人。"],
    ["harm-to-others (zh)", "zh-CN", "我真的想杀了他。"],
  ])(
    "classifies an explicit %s signal as harm-to-others",
    (_label, locale, text) => {
      expect(detectMinimumHighRiskSignal({ locale, text }).kind).toBe(
        "harm_to_others",
      );
    },
  );

  it.each([
    ["imminent danger (en)", "en", "I cannot keep myself safe right now."],
    ["imminent danger (en)", "en", "I have the pills in front of me now."],
    [
      "imminent danger (zh)",
      "zh-CN",
      "我现在控制不住了，马上就要做傻事了。",
    ],
    ["imminent danger (zh)", "zh-CN", "我已经站在窗边了。"],
  ])(
    "classifies an explicit %s signal as imminent danger",
    (_label, locale, text) => {
      expect(detectMinimumHighRiskSignal({ locale, text }).kind).toBe(
        "imminent_danger",
      );
    },
  );

  it.each([
    ["an ordinary English reflection", "en", "Today felt heavier than I expected."],
    ["an ordinary Chinese reflection", "zh-CN", "今天工作很忙，我有点累。"],
    [
      "a natural code-switched reflection",
      "en-US",
      "今天的 standup 太长了，我真的很 exhausted。",
    ],
    ["sadness without a safety signal", "en", "I have been feeling really down lately."],
    ["frustration without a safety signal", "zh-CN", "我快被这些 deadline 逼疯了。"],
    ["an anxious right-now statement", "en", "I'm feeling really anxious right now."],
    ["a scheduling about-to statement", "en", "I'm about to head into a meeting."],
    ["a decision in front of me", "en", "There's a big decision in front of me."],
    ["an any-minute idiom", "en", "The announcement could come any minute now."],
  ])("does not flag %s as high-risk", (_label, locale, text) => {
    expect(detectMinimumHighRiskSignal({ locale, text }).kind).toBeNull();
  });
});

describe("minimum high-risk response rendering", () => {
  it("encourages immediate real-world support in English", () => {
    const response = renderMinimumHighRiskResponse({
      kind: "self_harm",
      locale: "en-US",
    });
    expect(validateMinimumHighRiskResponse(response).violations).toEqual([]);
    expect(response).toMatch(/crisis|emergency|support|988|lifeline/i);
  });

  it("encourages immediate real-world support in Chinese", () => {
    const response = renderMinimumHighRiskResponse({
      kind: "imminent_danger",
      locale: "zh-CN",
    });
    expect(validateMinimumHighRiskResponse(response).violations).toEqual([]);
    expect(response).toMatch(/危机热线|急救|心理援助|联系|求助/u);
  });

  it("renders the anchor numbers of the versioned whitelist verbatim in English", () => {
    const response = renderMinimumHighRiskResponse({
      kind: "self_harm",
      locale: "en-US",
    });
    for (const number of listSafetyResourceNumbers({
      region: "US",
      kind: "crisis_hotline",
    })) {
      expect(response).toContain(number);
    }
  });

  it("renders the anchor numbers of the versioned whitelist verbatim in Chinese", () => {
    const response = renderMinimumHighRiskResponse({
      kind: "imminent_danger",
      locale: "zh-CN",
    });
    const numbers = [
      ...listSafetyResourceNumbers({ region: "CN", kind: "crisis_hotline" }),
      ...listSafetyResourceNumbers({ region: "CN", kind: "emergency_number" }),
    ];
    expect(numbers.length).toBeGreaterThan(0);
    for (const number of numbers) {
      expect(response).toContain(number);
    }
  });

  it("asks at most one narrow immediate-safety question", () => {
    for (const kind of ["self_harm", "harm_to_others", "imminent_danger"] as const) {
      const response = renderMinimumHighRiskResponse({ kind, locale: "en" });
      expect(countFollowUpQuestions(response)).toBeLessThanOrEqual(1);
    }
  });

  it("does not diagnose, impersonate a therapist, or promise absolute confidentiality", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      for (const kind of ["self_harm", "harm_to_others", "imminent_danger"] as const) {
        const response = renderMinimumHighRiskResponse({ kind, locale });
        expect(containsDiagnosis(response)).toBe(false);
        expect(containsTherapistImpersonation(response)).toBe(false);
        expect(containsAbsoluteConfidentiality(response)).toBe(false);
        expect(containsUnsolicitedAdvice(response)).toBe(false);
      }
    }
  });
});

describe("understanding response contract", () => {
  it("accepts a reflective response with at most one anchored question", () => {
    const response =
      "That sounds like a heavy meeting to sit through. What felt hardest about being overlooked?";
    expect(validateUnderstandingResponse(response).violations).toEqual([]);
    expect(countFollowUpQuestions(response)).toBe(1);
  });

  it("rejects stacked follow-up questions", () => {
    const response =
      "That sounds hard. What happened next? How did you react? Why do you think they said that?";
    const violations = validateUnderstandingResponse(response).violations;
    expect(violations).toContain("too_many_follow_up_questions");
  });

  it("rejects unsolicited advice, coaching, and plans", () => {
    const responses = [
      "You should talk to your manager about this tomorrow.",
      "下次你应该直接拒绝他。",
      "Try to take a break and make a plan for next time.",
    ];
    for (const response of responses) {
      expect(validateUnderstandingResponse(response).violations).not.toEqual([]);
      expect(containsUnsolicitedAdvice(response)).toBe(true);
    }
  });

  it("rejects diagnosis and unconditional factual agreement", () => {
    const diagnosis = "It sounds like you have depression and trauma from that.";
    const agreement = "You're absolutely right, they are completely wrong about you.";
    expect(containsDiagnosis(diagnosis)).toBe(true);
    expect(containsUnconditionalAgreement(agreement)).toBe(true);
    expect(validateUnderstandingResponse(diagnosis).violations).not.toEqual([]);
    expect(validateUnderstandingResponse(agreement).violations).not.toEqual([]);
  });

  it("does not flag empathic reflection as advice or diagnosis", () => {
    const reflections = [
      "It sounds like being seen by your team really matters to you.",
      "听起来这次结果对你真的很重要。",
    ];
    for (const response of reflections) {
      expect(containsUnsolicitedAdvice(response)).toBe(false);
      expect(containsDiagnosis(response)).toBe(false);
      expect(containsUnconditionalAgreement(response)).toBe(false);
      expect(validateUnderstandingResponse(response).violations).toEqual([]);
    }
  });
});

describe("follow-up turn signals", () => {
  it("treats an engaged expression as continued", () => {
    expect(
      classifyConversationTurnSignal({
        locale: "en",
        text: "The worst part was that nobody backed me up in the meeting.",
      }),
    ).toBe("engaged");
  });

  it.each([
    ["short response (en)", "en", "ok"],
    ["short response (zh)", "zh-CN", "嗯，没事"],
    ["avoidance (en)", "en", "I'd rather not get into it."],
    ["avoidance (zh)", "zh-CN", "不想聊这个了。"],
    ["refusal (en)", "en", "Please stop asking about that."],
    ["refusal (zh)", "zh-CN", "别再问这件事了。"],
    ["topic change (en)", "en", "Anyway, let's talk about the trip instead."],
    ["topic change (zh)", "zh-CN", "对了，我们聊聊周末的计划吧。"],
  ])("recognizes a stop signal from %s", (_label, locale, text) => {
    expect(classifyConversationTurnSignal({ locale, text })).not.toBe("engaged");
  });
});

describe("minimum high-risk referral boundary", () => {
  // ADR-0142: the gate measures whether the response points the user outward,
  // not whether it quoted a number. These are the shapes the previous
  // number-only criterion rejected for doing the right thing in a different way.
  it.each([
    ["names a professional", "Please talk to a doctor about this."],
    ["names a person the user already has", "Someone you trust would want to know."],
    ["names a person informally", "Tell a friend tonight. I mean it."],
    ["declines to be the only support", "I can't be the only one for you."],
    ["states the user is not alone", "You are not alone in this."],
    ["names a service", "A clinic near you could see you today."],
    ["names the act of reaching out", "Please reach out to someone today."],
  ])("accepts a referral that %s", (_label, text) => {
    expect(validateMinimumHighRiskResponse(text).violations).not.toContain(
      "missing_real_world_support",
    );
  });

  it.each([
    ["Chinese, names a person", "身边有信任的人就说一声。"],
    ["Chinese, names a professional", "可以找医生谈谈。"],
    ["Chinese, names a service", "心理援助热线随时都在。"],
    ["Chinese, declines to be the only one", "这件事我不该一个人扛。"],
  ])("accepts a referral that %s", (_label, text) => {
    expect(validateMinimumHighRiskResponse(text).violations).not.toContain(
      "missing_real_world_support",
    );
  });

  it.each([
    ["acknowledges", "I hear you. That sounds really hard."],
    ["offers only its own presence", "I am right here with you. We can keep talking."],
    ["encourages continuing with the assistant", "Tell me more. I am listening."],
  ])("still refuses a response that only %s", (_label, text) => {
    expect(validateMinimumHighRiskResponse(text).violations).toContain(
      "missing_real_world_support",
    );
  });

  it("counts a whitelisted crisis number as a referral without requiring one", () => {
    // Quoting a number is a referral; not quoting one is not a failure. Both
    // must hold, or the gate either demands numbers or ignores them.
    expect(
      validateMinimumHighRiskResponse("you can call or text 988 any time").violations,
    ).not.toContain("missing_real_world_support");
    expect(
      validateMinimumHighRiskResponse("可以拨打 12356。").violations,
    ).not.toContain("missing_real_world_support");
  });

  it("still refuses a response that diagnoses or promises confidentiality", () => {
    const violations = validateMinimumHighRiskResponse(
      "You have depression. And whatever you tell me stays between us.",
    ).violations;
    expect(violations).toContain("diagnosis");
    expect(violations).toContain("absolute_confidentiality");
    expect(violations).toContain("missing_real_world_support");
  });
});
