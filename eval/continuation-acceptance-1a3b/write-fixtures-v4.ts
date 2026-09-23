import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  V4Family,
  V4Scene,
  V4SceneFile,
  V4TargetRef,
  V4Turn,
} from "./protocol-v4";

type Language = "en" | "zh" | "code_switch";
type MemorySpec = Readonly<{
  id: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
}>;
type Spec = Readonly<{
  id: string;
  family: V4Family;
  language: Language;
  topic: string;
  rationale: string;
  first: string;
  second: string;
  opportunity: V4Turn["opportunity"];
  memory?: MemorySpec;
  historical?: string;
  target?: V4TargetRef;
  competitor?: V4TargetRef;
  reviewIntent: V4Scene["reviewIntent"];
  expectedOmissionReason?: V4Scene["expectedOmissionReason"];
  disposition?: NonNullable<V4Turn["expect"]["disposition"]>["signal"];
  protectedCategories?: V4Scene["protectedCategories"];
  coverageTags?: readonly string[];
  zeroOpportunity?: V4Turn["opportunity"];
  incompleteLane?: boolean;
  mentionTarget?: boolean;
}>;

const specs: readonly Spec[] = [
  // Eight positive Memory cases: the present turn is adjacent to one specific
  // fact, but does not repeat the stored fact.
  { id: "m01", family: "positive_memory", language: "en", topic: "running_base", rationale: "A new easy run naturally connects to an established half-marathon goal without repeating it.", first: "Could you help me make a simple grocery list for the weekend?", second: "I squeezed in an easy jog after work, and it felt less tiring than last week.", opportunity: "natural_gap", memory: { id: "mem-m01", kind: "objective_memory", text: "You are building a base for your first half marathon in the spring." }, target: { kind: "memory_claim", memoryId: "mem-m01" }, reviewIntent: "pairwise_candidate", protectedCategories: ["direct_task"], coverageTags: ["memory_acknowledgment", "direct_task"] },
  { id: "m02", family: "positive_memory", language: "en", topic: "pottery_class", rationale: "A small update about making time after work fits the user's ongoing pottery class.", first: "I need a quick checklist for packing tomorrow.", second: "I finally had an hour to myself tonight and made a little progress on something creative.", opportunity: "natural_gap", memory: { id: "mem-m02", kind: "objective_memory", text: "You started a beginner pottery class and were looking forward to learning the wheel." }, target: { kind: "memory_claim", memoryId: "mem-m02" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m03", family: "positive_memory", language: "en", topic: "dog_training", rationale: "A concrete, low-stakes update about a walk fits the ongoing work with the user's dog.", first: "What is a good way to organize these notes?", second: "We took the longer trail today, and the walk was calmer than usual.", opportunity: "natural_gap", memory: { id: "mem-m03", kind: "objective_memory", text: "You have been practicing loose-leash walking with your dog, Moss." }, target: { kind: "memory_claim", memoryId: "mem-m03" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m04", family: "positive_memory", language: "en", topic: "sister_visit", rationale: "A relaxed family update makes the planned visit a specific, answerable continuation without naming the person or trip.", first: "Can you help me compare these two calendar apps?", second: "I caught up with someone close to me on the phone and it was really nice.", opportunity: "natural_gap", memory: { id: "mem-m04", kind: "objective_memory", text: "You were planning to visit your sister Nora after her move to Portland." }, target: { kind: "memory_claim", memoryId: "mem-m04" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m05", family: "positive_memory", language: "zh", topic: "balcony_garden", rationale: "A small balcony gardening update is adjacent to the stored growing project without naming its plants.", first: "帮我把这段会议记录整理成三点。", second: "阳台上有新叶子长出来了，我剪掉几片枯叶，感觉状态不错。", opportunity: "natural_gap", memory: { id: "mem-m05", kind: "objective_memory", text: "你一直在阳台上种薄荷和罗勒。" }, target: { kind: "memory_claim", memoryId: "mem-m05" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m06", family: "positive_memory", language: "zh", topic: "evening_course", rationale: "A small learning update connects to the user's ongoing course without naming it.", first: "这封邮件语气能不能帮我改得更清楚一点？", second: "下班后我还是去参加了一个活动，前面卡住的内容今天终于听懂了。", opportunity: "natural_gap", memory: { id: "mem-m06", kind: "objective_memory", text: "你报名了周二晚上的基础日语课。" }, target: { kind: "memory_claim", memoryId: "mem-m06" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m07", family: "positive_memory", language: "zh", topic: "tea_blending", rationale: "A short note about a successful experiment sits naturally beside the user's interest in tea without repeating it.", first: "给我一个简单的周末清洁安排吧。", second: "我今天调了一个小配方，味道比预想的顺口。", opportunity: "natural_gap", memory: { id: "mem-m07", kind: "objective_memory", text: "你喜欢自己搭配不同的乌龙茶。" }, target: { kind: "memory_claim", memoryId: "mem-m07" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "m08", family: "positive_memory", language: "code_switch", topic: "jazz_piano", rationale: "A short practice update leaves room for a gentle connection to the user's concrete music goal without naming the instrument.", first: "Can you summarize this in one sentence?", second: "I finally made time to practice again tonight，手指比上次灵活一点。", opportunity: "natural_gap", memory: { id: "mem-m08", kind: "objective_memory", text: "You have been learning the jazz piano intro to 'Blue in Green'." }, target: { kind: "memory_claim", memoryId: "mem-m08" }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },

  // Eight Open Loops: each source statement names one unresolved matter and a
  // concrete date window; the new turn contains a real incoming-update cue.
  { id: "o01", family: "positive_open_loop", language: "en", topic: "rental_decision", rationale: "A newly arrived inbox message is a timely cue for the pending rental decision.", historical: "I submitted the rental application for the Cedar Street apartment; the manager said the decision should arrive by September 23.", first: "The commute was longer than I expected today.", second: "A couple of messages finally came in this morning, and I have not opened the last one yet.", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question", "greeting_or_pause"] },
  { id: "o02", family: "positive_open_loop", language: "en", topic: "conference_acceptance", rationale: "A new inbox reply arrives on the date the user expected an update, without naming its subject.", historical: "I sent my workshop proposal to the design conference, and they said I would hear back on September 23.", first: "I had a lot of small errands to get through today.", second: "I noticed a new reply in my inbox this morning, but I have not opened it yet.", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "o03", family: "positive_open_loop", language: "en", topic: "bike_repair", rationale: "A fresh notification on the expected update date is a timely cue without naming the pending repair.", historical: "The bike shop is checking the wheel on my commuter bike and promised an estimate by September 23.", first: "I finally got outside for a short walk.", second: "One notification came in while I was out, but I have not checked the details yet.", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "o04", family: "positive_open_loop", language: "en", topic: "volunteer_schedule", rationale: "A new alert appears on the promised update date while the user leaves its subject unstated.", historical: "I applied to help at the neighborhood food pantry; they said they would share the fall schedule by September 23.", first: "It has been a full day, but nothing especially dramatic happened.", second: "I saw something new come through today, and I have not had a chance to look yet.", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "o05", family: "positive_open_loop", language: "zh", topic: "scholarship_result", rationale: "The promised scholarship update is due today and the user has noticed a new message.", historical: "我提交了社区奖学金申请，对方说会在9月23日通知结果。", first: "今天事情比较多，刚刚才坐下来。", second: "邮箱里刚多了一封新邮件，我还没来得及看。", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question", "greeting_or_pause"] },
  { id: "o06", family: "positive_open_loop", language: "zh", topic: "guitar_repair", rationale: "A new alert says there has been progress on the expected update date without naming the matter.", historical: "琴行在检查我的吉他插孔，说9月23日左右会告诉我维修方案。", first: "我今天把桌面收拾干净了。", second: "我刚看到手机上有一条新提醒，说事情有进展。", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "o07", family: "positive_open_loop", language: "zh", topic: "bookstore_event", rationale: "A new update appears on the promised reply date while its subject remains unstated.", historical: "我在等书店确认下周读书会的场地，他们说9月23日会回复。", first: "今天通勤路上听完了一期播客。", second: "我刚看到有条新动态，还没来得及细看。", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "o08", family: "positive_open_loop", language: "code_switch", topic: "print_order", rationale: "A new notification arrives on the expected update date without identifying which pending matter it concerns.", historical: "I ordered the photo prints for my desk，店里说9月23日会通知我能不能取。", first: "I had a quiet lunch break and caught up on a few messages.", second: "Just got a notification while I was on break，我还没点开。", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question", "greeting_or_pause"] },

  // Six genuine competing pools. Each case has two eligible targets, and the
  // present cue supports only the declared winner.
  { id: "c01", family: "competing_pool", language: "en", topic: "rental_vs_baking", rationale: "A fresh inbox cue on the expected decision date makes the Open Loop more timely than the unrelated baking memory.", historical: "I submitted the rental application for Maple Court; the manager said the decision should arrive by September 23.", memory: { id: "mem-c01", kind: "objective_memory", text: "You like trying sourdough recipes on weekends." }, first: "I have been catching up on house things today.", second: "A new message just came in, and I have not opened it yet.", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, competitor: { kind: "memory_claim", memoryId: "mem-c01" }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "c02", family: "competing_pool", language: "en", topic: "choir_vs_garden", rationale: "A reflective music update is adjacent to the choir memory; the unrelated garden loop should lose.", historical: "The community garden coordinator said they would confirm my volunteer slot by September 23.", memory: { id: "mem-c02", kind: "objective_memory", text: "You joined the Thursday community choir and were learning the alto part." }, first: "I had a few things to finish after work.", second: "I had music on while I finished chores, and I caught myself humming along.", opportunity: "natural_gap", target: { kind: "memory_claim", memoryId: "mem-c02" }, competitor: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "c03", family: "competing_pool", language: "en", topic: "flight_vs_pottery", rationale: "A fresh notification on the promised reply date makes the pending travel decision more timely than the unrelated class memory.", historical: "I am waiting for the airline to confirm the seat change; they said they would reply by September 23.", memory: { id: "mem-c03", kind: "objective_memory", text: "You started a pottery class at the community studio." }, first: "I got through my morning meetings without any surprises.", second: "I noticed a fresh notification in my inbox this morning.", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, competitor: { kind: "memory_claim", memoryId: "mem-c03" }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "c04", family: "competing_pool", language: "zh", topic: "course_vs_ticket", rationale: "A small hands-on learning update is adjacent to the user's course memory; the pending concert ticket is unrelated.", historical: "我在等音乐节的候补票通知，对方说9月23日前会更新。", memory: { id: "mem-c04", kind: "objective_memory", text: "你报名了周末的烘焙入门课。" }, first: "今天处理完了几封工作邮件。", second: "我今天弄明白了一个之前卡住的小技巧，感觉顺手多了。", opportunity: "natural_gap", target: { kind: "memory_claim", memoryId: "mem-c04" }, competitor: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },
  { id: "c05", family: "competing_pool", language: "zh", topic: "venue_vs_walk", rationale: "A new email arrives on the promised reply date, making the Open Loop more timely than the unrelated walking memory.", historical: "我在等社区中心确认读书会的房间，对方说9月23日会回复。", memory: { id: "mem-c05", kind: "objective_memory", text: "你喜欢沿着河边散步。" }, first: "今天午饭吃得比平时晚。", second: "我刚收到一封新邮件，还没来得及点开看。", opportunity: "open_start", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, competitor: { kind: "memory_claim", memoryId: "mem-c05" }, reviewIntent: "pairwise_candidate", coverageTags: ["open_loop_question"] },
  { id: "c06", family: "competing_pool", language: "code_switch", topic: "podcast_vs_laptop", rationale: "A short recording update is adjacent to the user's neighborhood audio project, not the unrelated repair loop.", historical: "The repair shop is checking my laptop fan and said they would send an estimate by September 23.", memory: { id: "mem-c06", kind: "objective_memory", text: "You have been recording short neighborhood-history podcasts." }, first: "I finally cleared a few things from my desk.", second: "I recorded a quick intro for a neighborhood project，声音比上周自然。", opportunity: "natural_gap", target: { kind: "memory_claim", memoryId: "mem-c06" }, competitor: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "pairwise_candidate", coverageTags: ["memory_acknowledgment"] },

  // Stateful trajectories have a real first emit, a user stop signal, and a
  // later opportunity at which the persisted suppression must still hold.
  { id: "s01", family: "stateful_suppression", language: "en", topic: "job_interview_stop", rationale: "The first interview follow-up may be welcome, then the user explicitly declines and the next opening must stay quiet.", first: "I finally got a calm moment after work.", second: "I would rather not get into the interview today.", opportunity: "natural_gap", memory: { id: "mem-s01", kind: "objective_memory", text: "You had a second-round interview for a library role." }, target: { kind: "memory_claim", memoryId: "mem-s01" }, reviewIntent: "pairwise_candidate", disposition: "refused", protectedCategories: ["refusal"], coverageTags: ["memory_acknowledgment", "stop_signal"] },
  { id: "s02", family: "stateful_suppression", language: "en", topic: "houseplant_short", rationale: "A short answer after an initial follow-up must not trigger repeated prompting on the next turn.", first: "I have a little time before dinner.", second: "Yeah.", opportunity: "natural_gap", memory: { id: "mem-s02", kind: "objective_memory", text: "You were trying to keep a small collection of houseplants alive through summer." }, target: { kind: "memory_claim", memoryId: "mem-s02" }, reviewIntent: "pairwise_candidate", disposition: "short_response", protectedCategories: ["short_answer"], coverageTags: ["memory_acknowledgment", "short_answer", "stop_signal"] },
  { id: "s03", family: "stateful_suppression", language: "en", topic: "cousin_topic_change", rationale: "The user changes topics after the first segment; suppression must survive the unrelated next opening.", first: "I had a minute to catch up on messages.", second: "Anyway, did you see the new train schedule?", opportunity: "natural_gap", memory: { id: "mem-s03", kind: "objective_memory", text: "Your cousin Eli was preparing for a move to Seattle." }, target: { kind: "memory_claim", memoryId: "mem-s03" }, reviewIntent: "pairwise_candidate", disposition: "topic_changed", protectedCategories: ["topic_change"], coverageTags: ["memory_acknowledgment", "topic_change", "stop_signal"] },
  { id: "s04", family: "stateful_suppression", language: "en", topic: "garden_short", rationale: "A minimal reply counts as a stop signal and must suppress a repeated gardening question.", first: "I am settling in after a walk.", second: "Mm-hm.", opportunity: "natural_gap", memory: { id: "mem-s04", kind: "objective_memory", text: "You planted snap peas in a shared garden plot this spring." }, target: { kind: "memory_claim", memoryId: "mem-s04" }, reviewIntent: "pairwise_candidate", disposition: "short_response", protectedCategories: ["short_answer"], coverageTags: ["memory_acknowledgment", "short_answer", "stop_signal"] },
  { id: "s05", family: "stateful_suppression", language: "zh", topic: "class_refusal", rationale: "The user directly asks to leave the class topic; the next natural pause must respect that boundary.", first: "我刚忙完手头的事，能歇一会儿。", second: "这个课程先不聊了。", opportunity: "natural_gap", memory: { id: "mem-s05", kind: "objective_memory", text: "你报名了周三晚上的水彩课。" }, target: { kind: "memory_claim", memoryId: "mem-s05" }, reviewIntent: "pairwise_candidate", disposition: "refused", protectedCategories: ["refusal"], coverageTags: ["memory_acknowledgment", "stop_signal"] },
  { id: "s06", family: "stateful_suppression", language: "zh", topic: "moving_topic_change", rationale: "An explicit subject change after the first segment must prevent the old target from reappearing.", first: "今天终于提前下班了。", second: "先说点别的，我看到附近新开了一家店。", opportunity: "natural_gap", memory: { id: "mem-s06", kind: "objective_memory", text: "你之前在考虑搬到离公园近一点的地方。" }, target: { kind: "memory_claim", memoryId: "mem-s06" }, reviewIntent: "pairwise_candidate", disposition: "topic_changed", protectedCategories: ["topic_change"], coverageTags: ["memory_acknowledgment", "topic_change", "stop_signal"] },
  { id: "s07", family: "stateful_suppression", language: "zh", topic: "music_short", rationale: "A brief acknowledgment is enough to pause curiosity about the user's music practice.", first: "我刚回到家，准备做点吃的。", second: "嗯。", opportunity: "natural_gap", memory: { id: "mem-s07", kind: "objective_memory", text: "你最近在练习古筝的基础指法。" }, target: { kind: "memory_claim", memoryId: "mem-s07" }, reviewIntent: "pairwise_candidate", disposition: "short_response", protectedCategories: ["short_answer"], coverageTags: ["memory_acknowledgment", "short_answer", "stop_signal"] },
  { id: "s08", family: "stateful_suppression", language: "code_switch", topic: "photo_topic_change", rationale: "The user switches away from the photo project; a later casual update must not reopen it.", first: "I had a little free time on the train.", second: "Anyway，let's talk about something else for now.", opportunity: "natural_gap", memory: { id: "mem-s08", kind: "objective_memory", text: "You were making a small photo book from your coastal trip." }, target: { kind: "memory_claim", memoryId: "mem-s08" }, reviewIntent: "pairwise_candidate", disposition: "topic_changed", protectedCategories: ["topic_change"], coverageTags: ["memory_acknowledgment", "topic_change", "stop_signal"] },

  // Eight predeclared negative controls. Each target is selected so the
  // expression Provider must decide to omit; the expected reason stays private.
  { id: "x01", family: "omission_contract", language: "en", topic: "distant_memory", rationale: "A generic okay-day update has no natural bridge to an unrelated old hobby.", first: "Could you help me find a short podcast for the drive?", second: "Today was fine, nothing much happened.", opportunity: "natural_gap", memory: { id: "mem-x01", kind: "objective_memory", text: "You once mentioned enjoying model trains as a child." }, target: { kind: "memory_claim", memoryId: "mem-x01" }, reviewIntent: "omission_audit", expectedOmissionReason: "no_genuine_opportunity", coverageTags: ["no_real_opportunity"] },
  { id: "x02", family: "omission_contract", language: "en", topic: "main_may_cover_launch", rationale: "The user mentions a vague update from the same work group; the main response may already pick up the pending announcement, so the expression must check for duplication.", first: "I have a quick update from work.", second: "A teammate shared an update in our team chat this morning, but I have not opened it yet.", opportunity: "natural_gap", memory: { id: "mem-x02", kind: "objective_memory", text: "You were waiting for your team to announce the new product launch." }, target: { kind: "memory_claim", memoryId: "mem-x02" }, reviewIntent: "omission_audit", expectedOmissionReason: "duplicates_main_response", coverageTags: ["main_response_overlap"] },
  { id: "x03", family: "omission_contract", language: "zh", topic: "vague_work_change", rationale: "The memory is too vague to support a specific follow-up or a confident subject claim.", first: "我今天把几件小事处理完了。", second: "工作上好像有些变化，暂时还说不清。", opportunity: "natural_gap", memory: { id: "mem-x03", kind: "ai_impression", text: "你之前提过工作方面可能有变化。" }, target: { kind: "memory_claim", memoryId: "mem-x03" }, reviewIntent: "omission_audit", expectedOmissionReason: "insufficient_grounding", coverageTags: ["weak_grounding"] },
  { id: "x04", family: "omission_contract", language: "zh", topic: "late_night_closure", rationale: "The user has explicitly closed the exchange for the night, so an unrelated pending target should wait.", historical: "我在等书店确认周末取书的时间，对方说9月23日会回复。", first: "今天已经有点晚了。", second: "我先去睡了，晚安。", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "omission_audit", expectedOmissionReason: "timing_not_natural", coverageTags: ["closure_cue", "open_loop_question"] },
  { id: "x05", family: "omission_contract", language: "en", topic: "unrelated_bicycle", rationale: "An uneventful commute has no real connection to an old bicycle accessory memory.", first: "I finished a few chores and made lunch.", second: "The bus was on time for once.", opportunity: "natural_gap", memory: { id: "mem-x05", kind: "objective_memory", text: "You used to ride a blue bicycle with a front basket." }, target: { kind: "memory_claim", memoryId: "mem-x05" }, reviewIntent: "omission_audit", expectedOmissionReason: "no_genuine_opportunity", coverageTags: ["no_real_opportunity"] },
  { id: "x06", family: "omission_contract", language: "zh", topic: "main_may_cover_plans", rationale: "A broad update after talking with a friend may already lead the main response to address the pending plans, so the expression must avoid asking the same thing twice.", first: "我刚收到朋友发来的照片。", second: "我和朋友聊了聊最近的安排，感觉事情在慢慢定下来。", opportunity: "natural_gap", memory: { id: "mem-x06", kind: "objective_memory", text: "你在等朋友确认这周末海边短途旅行的安排。" }, target: { kind: "memory_claim", memoryId: "mem-x06" }, reviewIntent: "omission_audit", expectedOmissionReason: "duplicates_main_response", coverageTags: ["main_response_overlap"] },
  { id: "x07", family: "omission_contract", language: "en", topic: "unclear_old_plan", rationale: "A vague historical statement cannot establish what the user was waiting for.", first: "I got through the afternoon without much trouble.", second: "Maybe there will be some news sometime soon, but I am not sure.", opportunity: "natural_gap", historical: "I might hear about something from someone later this month.", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "omission_audit", expectedOmissionReason: "insufficient_grounding", coverageTags: ["weak_grounding", "open_loop_question"] },
  { id: "x08", family: "omission_contract", language: "code_switch", topic: "bedtime_closure", rationale: "The user says good night and asks not to reply; a follow-up would interrupt closure.", first: "I finally got home after a long day.", second: "I'm heading to bed now，no need to reply. Good night.", opportunity: "natural_gap", memory: { id: "mem-x08", kind: "objective_memory", text: "You were planning to visit the botanical garden this month." }, target: { kind: "memory_claim", memoryId: "mem-x08" }, reviewIntent: "omission_audit", expectedOmissionReason: "timing_not_natural", coverageTags: ["closure_cue"] },

  // Contract-only zero scenes never enter the expression Provider.
  { id: "z01", family: "correct_zero", language: "en", topic: "active_task", rationale: "An explicit task is being answered and does not admit an unrelated proactive target.", first: "Can you help me choose a train route for tomorrow?", second: "I need the option with the fewest transfers.", opportunity: "direct_task", zeroOpportunity: "direct_task", reviewIntent: "contract_only", memory: { id: "mem-z01", kind: "objective_memory", text: "You enjoy baking rye bread." }, coverageTags: ["direct_task"] },
  { id: "z02", family: "correct_zero", language: "en", topic: "active_topic", rationale: "The user is actively explaining a current issue; the focus=false gate cannot manufacture an opportunity.", first: "I am still trying to untangle a disagreement with my neighbor.", second: "I want to explain the part that happened this morning.", opportunity: "current_topic", zeroOpportunity: "current_topic", reviewIntent: "contract_only", memory: { id: "mem-z02", kind: "objective_memory", text: "You were planning to take a weekend drawing class." }, coverageTags: ["current_topic"] },
  { id: "z03", family: "correct_zero", language: "en", topic: "high_risk_boundary", rationale: "A high-risk disclosure remains the only topic and must not be followed by an old memory.", first: "I feel unsafe being alone tonight.", second: "I am trying to contact someone who can stay with me.", opportunity: "urgent_or_high_risk", zeroOpportunity: "urgent_or_high_risk", reviewIntent: "contract_only", memory: { id: "mem-z03", kind: "objective_memory", text: "You were considering a photography workshop." }, protectedCategories: ["high_risk"], coverageTags: ["high_risk"] },
  { id: "z04", family: "correct_zero", language: "zh", topic: "direct_request", rationale: "A direct request for a translation takes the turn; no past target is appended.", first: "请把这段话翻译成英文。", second: "语气保持正式，适合发给客户。", opportunity: "direct_task", zeroOpportunity: "direct_task", reviewIntent: "contract_only", memory: { id: "mem-z04", kind: "objective_memory", text: "你最近在学做手冲咖啡。" }, protectedCategories: ["direct_task"], coverageTags: ["direct_task"] },
  { id: "z05", family: "correct_zero", language: "zh", topic: "topic_closure", rationale: "The user signals they are done for now, so silence is the natural result.", first: "我已经把今天的事情处理完了。", second: "先这样吧，不用再问了。", opportunity: "current_topic", zeroOpportunity: "current_topic", reviewIntent: "contract_only", memory: { id: "mem-z05", kind: "objective_memory", text: "你喜欢在周末逛旧书店。" }, coverageTags: ["stop_signal"] },
  { id: "z06", family: "correct_zero", language: "code_switch", topic: "incomplete_lane", rationale: "An incomplete Open Loop lane cannot be partially used even when a memory candidate exists.", first: "I got a message about a new opportunity.", second: "还有一部分细节我还没确认。", opportunity: "natural_gap", zeroOpportunity: "natural_gap", reviewIntent: "contract_only", memory: { id: "mem-z06", kind: "objective_memory", text: "You collect small illustrated travel maps." }, incompleteLane: true, coverageTags: ["incomplete_lane"] },
  { id: "z07", family: "correct_zero", language: "en", topic: "target_raised_in_exchange", rationale: "The user has already raised the exact pending application in this exchange, so it must stay in normal conversation.", historical: "I sent my workshop proposal to the design conference, and they said I would hear back on September 23.", first: "I had a quiet day after work.", second: "The conference team finally sent me their answer this morning.", opportunity: "natural_gap", target: { kind: "open_loop", sourceTurn: 0, ordinal: 0 }, reviewIntent: "contract_only", mentionTarget: true, coverageTags: ["same_target_already_mentioned"] },
];

const locales: Readonly<Record<Language, Readonly<{ locale: string; timezone: string }>>> = {
  en: { locale: "en-US", timezone: "America/Los_Angeles" },
  zh: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  code_switch: { locale: "en-US", timezone: "America/Los_Angeles" },
};

function targetFor(spec: Spec): V4TargetRef {
  if (spec.target) return spec.target;
  if (spec.memory) return { kind: "memory_claim", memoryId: spec.memory.id };
  return { kind: "open_loop", sourceTurn: 0, ordinal: 0 };
}

function fixtureTurn(input: {
  language: Language;
  sequence: number;
  text: string;
  opportunity: V4Turn["opportunity"];
  focusRequired: boolean;
  selection: "segment" | "none";
  target?: V4TargetRef;
  zeroReason?: V4Turn["expect"]["zeroReason"];
  disposition?: NonNullable<V4Turn["expect"]["disposition"]>;
  suppressedAfter?: V4TargetRef;
  excludedTarget?: V4TargetRef;
  excludedReason?: V4Turn["expect"]["excludedReason"];
  incompleteLane?: boolean;
  mentionedTargets?: readonly V4TargetRef[];
}): V4Turn {
  const locale = locales[input.language];
  return {
    sequenceInScenario: input.sequence,
    userInput: { locale: locale.locale, text: input.text, timezone: locale.timezone },
    opportunity: input.opportunity,
    focusRequired: input.focusRequired,
    ...(input.incompleteLane ? { incompleteLane: true } : {}),
    ...(input.mentionedTargets
      ? { mentionedTargets: input.mentionedTargets }
      : {}),
    expect: {
      selection: input.selection,
      ...(input.target ? { target: input.target } : {}),
      ...(input.zeroReason ? { zeroReason: input.zeroReason } : {}),
      ...(input.disposition ? { disposition: input.disposition } : {}),
      ...(input.suppressedAfter ? { suppressedAfter: input.suppressedAfter } : {}),
      ...(input.excludedTarget ? { excludedTarget: input.excludedTarget } : {}),
      ...(input.excludedReason ? { excludedReason: input.excludedReason } : {}),
    },
  };
}

function toScene(spec: Spec): V4Scene {
  const locale = locales[spec.language];
  const target = targetFor(spec);
  const memory = spec.memory
    ? [{ ...spec.memory, sensitive: false, evidenceIds: [`evidence-${spec.memory.id}`] }]
    : [];
  const firstTurn = fixtureTurn({
    language: spec.language,
    sequence: 1,
    text: spec.first,
    opportunity:
      spec.family === "correct_zero"
        ? spec.incompleteLane
          ? "current_topic"
          : spec.zeroOpportunity ?? "direct_task"
        : spec.opportunity,
    focusRequired: spec.family === "correct_zero",
    selection: spec.family === "correct_zero" ? "none" : "segment",
    ...(spec.family === "correct_zero" ? { zeroReason: "focus_required_by_opportunity" as const } : { target }),
  });
  let turns: V4Turn[];
  if (spec.family === "stateful_suppression") {
    const signal = spec.disposition ?? "short_response";
    turns = [
      firstTurn,
      fixtureTurn({
        language: spec.language,
        sequence: 2,
        text: spec.second,
        opportunity: "current_topic",
        focusRequired: true,
        selection: "none",
        zeroReason: "focus_required_by_opportunity",
        disposition: { signal, target },
        suppressedAfter: target,
      }),
      fixtureTurn({
        language: spec.language,
        sequence: 3,
        text: spec.language === "zh" ? "后来我做了点别的，心情平静多了。" : "Later I did something else and felt more settled.",
        opportunity: "natural_gap",
        focusRequired: false,
        selection: "none",
        zeroReason: "no_eligible_target",
        excludedTarget: target,
        excludedReason: "suppressed",
      }),
    ];
  } else if (spec.family === "correct_zero") {
    turns = [
      firstTurn,
      fixtureTurn({
        language: spec.language,
        sequence: 2,
        text: spec.second,
        opportunity: spec.zeroOpportunity ?? spec.opportunity,
        focusRequired: spec.mentionTarget ? false : true,
        selection: "none",
        zeroReason: spec.incompleteLane
          ? "lane_not_readable"
          : spec.mentionTarget
            ? "no_eligible_target"
            : "focus_required_by_opportunity",
        ...(spec.incompleteLane ? { incompleteLane: true } : {}),
        ...(spec.mentionTarget
          ? {
              mentionedTargets: [target],
              excludedTarget: target,
              excludedReason: "mentioned_in_exchange" as const,
            }
          : {}),
      }),
    ];
  } else {
    turns = [
      fixtureTurn({
        language: spec.language,
        sequence: 1,
        text: spec.first,
        opportunity: "current_topic",
        focusRequired: true,
        selection: "none",
        zeroReason: "focus_required_by_opportunity",
      }),
      fixtureTurn({
        language: spec.language,
        sequence: 2,
        text: spec.second,
        opportunity: spec.opportunity,
        focusRequired: false,
        selection: "segment",
        target,
        ...(spec.family === "omission_contract" ? {} : {}),
      }),
    ];
  }
  return {
    id: `g2-v4-${spec.id}`,
    family: spec.family,
    languageVariant: spec.language,
    locale: locale.locale,
    timezone: locale.timezone,
    topic: spec.topic,
    description: spec.rationale,
    rationale: spec.rationale,
    reviewIntent: spec.reviewIntent,
    ...(spec.expectedOmissionReason ? { expectedOmissionReason: spec.expectedOmissionReason } : {}),
    coverageTags: spec.coverageTags ?? [],
    protectedCategories: spec.protectedCategories ?? [],
    opportunity: spec.opportunity ?? "natural_gap",
    historicalEvents: spec.historical ? [{ locale: locale.locale, text: spec.historical }] : [],
    memory,
    portrait: [],
    ...(spec.competitor ? { competitors: [spec.competitor] } : {}),
    turns,
  };
}

function rawHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const families: readonly V4Family[] = [
    "positive_memory",
    "positive_open_loop",
    "competing_pool",
    "stateful_suppression",
    "omission_contract",
    "correct_zero",
  ];
  const sceneFiles: Array<{ path: string; sha256: string }> = [];
  for (const family of families) {
    const sceneFile: V4SceneFile = {
      version: "1a3b-g2-scenes:v4",
      synthetic: true,
      family,
      scenes: specs.filter((spec) => spec.family === family).map(toScene),
    };
    const relativePath = `eval/continuation-acceptance-1a3b/fixtures-v4/${family}.json`;
    const raw = `${JSON.stringify(sceneFile, null, 2)}\n`;
    await mkdir(dirname(relativePath), { recursive: true });
    await writeFile(relativePath, raw, "utf8");
    sceneFiles.push({ path: relativePath, sha256: rawHash(raw) });
  }
  const catalog = {
    version: "1a3b-g2-continuation:v4",
    synthetic: true,
    syntheticNotice: "Synthetic evaluation fixtures only. No real user data or production content.",
    sceneFiles,
  };
  await writeFile(
    "eval/continuation-acceptance-1a3b/fixtures-v4.json",
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
