import type {
  LexicalSurface,
  PredicateLocalization,
  PredicateRelation,
  RelationshipProjectionLocalization,
} from "./types";
import { PREDICATE_IDS } from "./v1";

/**
 * Bilingual natural-language material for Registry v1 (#93 §9): per entry per
 * locale label + definition + ≥2 positive + ≥2 negative seed examples;
 * relationship entries additionally carry forward / inverse / symmetric
 * projection templates including former forms and all neutral fallback words.
 *
 * `lexicalSurfaces` are the governed alias surface: exactly these spellings
 * participate in deterministic forward mapping (and later the published
 * lexical lane); anything outside the published surface resolves to
 * ambiguous/unmapped and never to a near-synonym predicate.
 */

type Loc = Omit<PredicateLocalization, "localizationVersion">;

const peer = (
  locale: LexicalSurface["locale"],
  text: string,
  form: LexicalSurface["form"] = "current",
): LexicalSurface => Object.freeze({ text, locale, roleSide: "peer", form });

const subjectDenoter = (
  locale: LexicalSurface["locale"],
  text: string,
  form: LexicalSurface["form"] = "current",
): LexicalSurface =>
  Object.freeze({
    text,
    locale,
    roleSide: "canonical_subject_denoter",
    form,
  });

const counterpartDenoter = (
  locale: LexicalSurface["locale"],
  text: string,
  form: LexicalSurface["form"] = "current",
): LexicalSurface =>
  Object.freeze({
    text,
    locale,
    roleSide: "counterpart_denoter",
    form,
  });

const V = 1;

/**
 * Registry-owned retrieval aliases for the #126 work-context probes. These
 * are published lexical surfaces, not inferred synonyms; the same surfaces
 * are intentionally owned by both work predicates so retrieval preserves the
 * former bridge candidate set.
 */
const WORK_CONTEXT_RETRIEVAL_ALIASES_ZH = Object.freeze([
  peer("zh", "新工作"),
  peer("zh", "换工作"),
  peer("zh", "工作的事"),
  peer("zh", "新 work"),
]);
const WORK_CONTEXT_RETRIEVAL_ALIASES_EN = Object.freeze([peer("en", "new job")]);

export function buildLocalizationsV1(): readonly PredicateLocalization[] {
  const locs: Loc[] = [
    // ── sh.relationship.partner_of ────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.partnerOf,
      locale: "zh",
      label: "伴侣关系",
      definition:
        "用户与另一名成年人之间的恋爱或婚姻伴侣关系（男女朋友、未婚夫妻、夫妻）。只承认用户直接陈述；对称关系，提及顺序不影响同一 Claim。结束的关系以 former 形态投影，重启复用原 logical Claim。",
      positiveExamples: [
        "我和小李在一起三年了，他是我男朋友。",
        "我跟阿琳最近领证了，她是我老婆。",
      ],
      negativeExamples: [
        "我妈很喜欢我女朋友。——长辈评价不构成新的伴侣关系主体变换",
        "我们是很好的搭档、工作上很默契。——协作不是伴侣",
      ],
      lexicalSurfaces: [
        peer("zh", "男朋友"),
        peer("zh", "女朋友"),
        // code-switching loanwords (ADR-0072)
        peer("zh", "boyfriend"),
        peer("zh", "girlfriend"),
        peer("zh", "老公"),
        peer("zh", "老婆"),
        peer("zh", "丈夫"),
        peer("zh", "妻子"),
        peer("zh", "未婚夫"),
        peer("zh", "未婚妻"),
        peer("zh", "对象"),
        peer("zh", "伴侣"),
        peer("zh", "前男友", "former"),
        peer("zh", "前女友", "former"),
        peer("zh", "前任", "former"),
        peer("zh", "前妻", "former"),
        peer("zh", "前夫", "former"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.partnerOf,
      locale: "en",
      label: "Romantic partner",
      definition:
        "A romantic or marital partnership between the user and another adult (boyfriend/girlfriend, fiancé(e), spouse). Stated directly by the user only; symmetric — mention order never changes the claim identity. Ended partnerships project in former form.",
      positiveExamples: [
        "Tom and I got engaged last month — he is my fiancé.",
        "Mei is my girlfriend; we've been together for two years.",
      ],
      negativeExamples: [
        "My mom thinks my girlfriend is lovely. — a parent commenting creates nothing new",
        "Dan is a great business partner on the side project. — collaboration is not romance",
      ],
      lexicalSurfaces: [
        peer("en", "boyfriend"),
        peer("en", "girlfriend"),
        peer("en", "fiancé"),
        peer("en", "fiance"),
        peer("en", "fiancée"),
        peer("en", "husband"),
        peer("en", "wife"),
        peer("en", "spouse"),
        peer("en", "ex-boyfriend", "former"),
        peer("en", "ex-girlfriend", "former"),
        peer("en", "ex-wife", "former"),
        peer("en", "ex-husband", "former"),
      ],
    },

    // ── sh.relationship.parent_of ────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.parentOf,
      locale: "zh",
      label: "亲子关系（父母方）",
      definition:
        "以家长为 canonical subject 的亲子关系：subject=家长，object=子女。“我是孩子的妈妈”与“孩子是我儿子”归一化为同一条逻辑 Claim 的两个版本方向。核心三带之一，永不并入亲戚泛化条目。",
      positiveExamples: [
        "我是我儿子的家长，他今年上小学。",
        "我女儿出生刚满一岁，每天都要哄睡。",
      ],
      negativeExamples: [
        "我表姐家的小孩特别闹。——他人之子不入 Self 亲子 Claim",
        "邻居阿姨像我妈一样照顾我。——比喻与照护不是血缘亲子",
      ],
      lexicalSurfaces: [
        subjectDenoter("zh", "妈妈"),
        subjectDenoter("zh", "爸爸"),
        subjectDenoter("zh", "母亲"),
        subjectDenoter("zh", "父亲"),
        counterpartDenoter("zh", "儿子"),
        counterpartDenoter("zh", "女儿"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.parentOf,
      locale: "en",
      label: "Parent–child (parent side)",
      definition:
        "Parent-child relation with the parent as canonical subject; child-side utterances (“my son”) canonicalize onto the same logical claim. One of the three core kinship bands; never folds into generalized relatives.",
      positiveExamples: [
        "I'm a new dad — my son just turned one.",
        "My daughter started kindergarten this fall.",
      ],
      negativeExamples: [
        "My cousin's kid is adorable. — someone else's child is not a Self claim here",
        "My landlady treats me like a son. — metaphor is not kinship",
      ],
      lexicalSurfaces: [
        subjectDenoter("en", "mom"),
        subjectDenoter("en", "dad"),
        subjectDenoter("en", "mother"),
        subjectDenoter("en", "father"),
        counterpartDenoter("en", "son"),
        counterpartDenoter("en", "daughter"),
      ],
    },

    // ── sh.relationship.sibling_of ───────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.siblingOf,
      locale: "zh",
      label: "手足关系",
      definition:
        "兄弟姐妹之间的对称关系。哥哥/姐姐/弟弟/妹妹词面即证据；长幼称谓可入 Qualifier 但不改 Claim identity；不并入亲戚泛化。",
      positiveExamples: [
        "我哥哥大我五岁，从小带我打球。",
        "我和我妹妹每周都视频一次。",
      ],
      negativeExamples: [
        "我干姐对我特别好。——干亲是明确推迟概念，不得落手足",
        "一起长大的发小情同手足。——情同手足是修辞，不自动成立关系",
      ],
      lexicalSurfaces: [
        peer("zh", "哥哥"),
        peer("zh", "姐姐"),
        peer("zh", "弟弟"),
        peer("zh", "妹妹"),
        peer("zh", "手足"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.siblingOf,
      locale: "en",
      label: "Sibling",
      definition:
        "Symmetric brother/sister relation between the user and a sibling. Age-order wording may refine a qualifier but never changes claim identity.",
      positiveExamples: [
        "My brother is five years older and taught me tennis.",
        "I call my little sister every weekend.",
      ],
      negativeExamples: [
        "My sworn sister from college — sworn kinship is deferred vocabulary.",
        "We grew up next door like brothers. — rhetoric does not create the relation",
      ],
      lexicalSurfaces: [
        peer("en", "brother"),
        peer("en", "sister"),
        peer("en", "sibling"),
      ],
    },

    // ── sh.relationship.friend_of ────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.friendOf,
      locale: "zh",
      label: "朋友关系",
      definition:
        "对称的朋友关系。双轴 Qualifier：relation_origin（发小/同学/球友等来处词面）与 stated_closeness（闺蜜死党挚友→best；好朋友好友→close；普通朋友→casual）。来处词面单独出现（如“他是我的邻居”）不成立朋友关系。",
      positiveExamples: [
        "小周是我最好的闺蜜，什么话都能聊。",
        "老陈是我的普通朋友，平时就是打球认识的一个球友。",
      ],
      negativeExamples: [
        "我的同事今天又迟到了。——仅有同事身份不构成朋友声明",
        "隔壁邻居帮过我很多忙。——邻居是推迟概念，不落朋友也不落亲缘",
      ],
      lexicalSurfaces: [
        peer("zh", "朋友"),
        peer("zh", "好朋友"),
        peer("zh", "好友"),
        peer("zh", "闺蜜"),
        peer("zh", "死党"),
        peer("zh", "挚友"),
        peer("zh", "普通朋友"),
        // code-switching loanwords observed in real zh speech (ADR-0072)
        peer("zh", "bestie"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.friendOf,
      locale: "en",
      label: "Friend",
      definition:
        "Symmetric friendship. Two qualifier axes: relation_origin (childhood friend, teammate, …) and stated_closeness (bestie/best_friend → best; good/close friend → close; casual friend → casual). An origin mention alone (“he is my neighbor”) never states friendship.",
      positiveExamples: [
        "Anna is my bestie — we tell each other everything.",
        "Ben is a casual friend from my climbing gym.",
      ],
      negativeExamples: [
        "My coworker grabbed coffee with me. — coworker status alone is not friendship",
        "My neighbor helped carry my sofa. — neighbor is deferred vocabulary, not a fold-in",
      ],
      lexicalSurfaces: [
        peer("en", "friend"),
        peer("en", "good friend"),
        peer("en", "close friend"),
        peer("en", "bestie"),
        peer("en", "best friend"),
        peer("en", "casual friend"),
      ],
    },

    // ── sh.relationship.colleague_of ────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.colleagueOf,
      locale: "zh",
      label: "同事关系",
      definition:
        "对称的共事关系，v1 无结构化 Qualifier。词面“同事”即证据；“领导/上司”归属管理关系条目，高混淆对在此分离。",
      positiveExamples: [
        "我和她是同事，都在产品部。",
        "小郑跟我同一个组，我们天天一起对需求，是同事。",
      ],
      negativeExamples: [
        "她是我领导，这次晋升她说了算。——上下级归 sh.relationship.manager_of",
        "我们曾经是同事，现在各奔东西只算旧识。——历史共事需 former 形态另评，当前态不入",
      ],
      lexicalSurfaces: [
        peer("zh", "同事"),
        peer("zh", "前同事", "former"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.colleagueOf,
      locale: "en",
      label: "Colleague",
      definition:
        "Symmetric co-worker relation; “boss/manager” wording belongs to the manager predicate — a declared confusable pair kept separate.",
      positiveExamples: [
        "Rae and I are colleagues on the platform team.",
        "Ken joined my old team; we're coworkers now.",
      ],
      negativeExamples: [
        "She is my boss and decides promotions. — subordination maps to sh.relationship.manager_of",
        "My client keeps emails very formal. — client relations are deferred entirely",
      ],
      lexicalSurfaces: [
        peer("en", "colleague"),
        peer("en", "coworker"),
        peer("en", "ex-colleague", "former"),
      ],
    },

    // ── sh.relationship.manager_of ─────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.managerOf,
      locale: "zh",
      label: "上下级关系（经理方）",
      definition:
        "directed 关系：canonical subject=经理方。无论说“她是我领导”还是“我是他的下属”，都归一化为经理为主体的同一逻辑 Claim；绝不退化落到同事。",
      positiveExamples: [
        "她是我领导，每周给我做一对一。",
        "我自己带三个人的小组，他们都是我的下属。",
      ],
      negativeExamples: [
        "他就是个普通同事，偶尔同步进度。——无领导语面不得升格为上下级",
        "我家楼下健身房教练管我很严。——训练指导不是雇佣上下级",
      ],
      lexicalSurfaces: [
        subjectDenoter("zh", "领导"),
        subjectDenoter("zh", "上司"),
        subjectDenoter("zh", "经理"),
        counterpartDenoter("zh", "下属"),
        // code-switching loanword (ADR-0072): “她是我 boss”
        subjectDenoter("zh", "boss"),
        subjectDenoter("zh", "前领导", "former"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.managerOf,
      locale: "en",
      label: "Reports-to (manager side)",
      definition:
        "Directed relation, canonical subject = the manager. “She is my boss” and “I report to her” canonicalize to the same logical claim; never degraded into colleague.",
      positiveExamples: [
        "Dana is my boss — she runs weekly one-on-ones.",
        "I manage three direct reports on my team.",
      ],
      negativeExamples: [
        "He's just another coworker who syncs updates. — no management language, no upgrade",
        "The class monitor keeps us on schedule. — organizing peers is not employment",
      ],
      lexicalSurfaces: [
        subjectDenoter("en", "boss"),
        subjectDenoter("en", "manager"),
        counterpartDenoter("en", "report"),
        counterpartDenoter("en", "subordinate"),
        subjectDenoter("en", "former boss", "former"),
      ],
    },

    // ── sh.relationship.relative_of ─────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.relativeOf,
      locale: "zh",
      label: "亲属关系（泛化血亲）",
      definition:
        "对称的泛化血亲关系。准确称谓存入 kinship_term 词面 Qualifier（爷爷/外婆/姑姑/舅舅/表姐……）；纠错（姑姑→姨妈）只改 Qualifier 不换 Claim。核心三带（伴侣/亲子/手足）不并入本条目。",
      positiveExamples: [
        "我姑姑这个周末要从南京过来住两天。",
        "我表姐刚生了宝宝，我要当表舅了。",
      ],
      negativeExamples: [
        "我婆婆做饭特别好吃。——姻亲归 sh.relationship.in_law_of，不入血亲条目",
        "我爸那边的远房算是拐弯亲戚吧，我也说不清。——模糊归属先 unmapped，不猜",
      ],
      lexicalSurfaces: [
        peer("zh", "爷爷"),
        peer("zh", "奶奶"),
        peer("zh", "外公"),
        peer("zh", "外婆"),
        peer("zh", "姑姑"),
        peer("zh", "姨妈"),
        peer("zh", "叔叔"),
        peer("zh", "伯伯"),
        peer("zh", "舅舅"),
        peer("zh", "表姐"),
        peer("zh", "表哥"),
        peer("zh", "表弟"),
        peer("zh", "表妹"),
        peer("zh", "堂姐"),
        peer("zh", "堂哥"),
        peer("zh", "堂弟"),
        peer("zh", "堂妹"),
        peer("zh", "侄子"),
        peer("zh", "侄女"),
        peer("zh", "外甥"),
        peer("zh", "外甥女"),
        peer("zh", "孙子"),
        peer("zh", "孙女"),
        peer("zh", "亲戚"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.relativeOf,
      locale: "en",
      label: "Relative (generalized kin)",
      definition:
        "Symmetric generalized blood relation. The exact kinship term goes into the kinship_term qualifier (grandma/aunt/cousin…); corrections swap the qualifier, not the claim. Core bands (partner/parent/sibling) never fold in here; in-laws belong to their own predicate.",
      positiveExamples: [
        "My aunt is visiting from Nanjing this weekend.",
        "My cousin just had a baby girl.",
      ],
      negativeExamples: [
        "My mother-in-law cooks amazingly. — in-laws map to sh.relationship.in_law_of",
        "Some distant relative twice removed, honestly unclear. — vague attribution stays unmapped",
      ],
      lexicalSurfaces: [
        peer("en", "grandpa"),
        peer("en", "grandma"),
        peer("en", "aunt"),
        peer("en", "uncle"),
        peer("en", "cousin"),
        peer("en", "nephew"),
        peer("en", "niece"),
        peer("en", "relative"),
      ],
    },

    // ── sh.relationship.in_law_of ───────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.inLawOf,
      locale: "zh",
      label: "姻亲关系（长辈代为尊）",
      definition:
        "directed：canonical subject=长辈一代（公婆/岳父母为 subject；儿媳女婿话面则用户为长辈方）。“我婆婆”一词本身就是直接陈述证据，不经配偶链推导；第三方姻亲闭包语言不产 Self Claim。",
      positiveExamples: [
        "我婆婆周末做了一大桌子菜。",
        "我们家儿媳妇上个月刚过门，小两口很恩爱。",
      ],
      negativeExamples: [
        "我姐夫的爸妈下个月来玩。——配偶同胞的姻亲是三方闭包，不生成 Self Claim",
        "我们还没结婚，女友的妈妈只是未来婆婆。——未成立婚约不定姻亲身份",
      ],
      lexicalSurfaces: [
        subjectDenoter("zh", "婆婆"),
        subjectDenoter("zh", "公公"),
        subjectDenoter("zh", "岳母"),
        subjectDenoter("zh", "岳父"),
        subjectDenoter("zh", "丈母娘"),
        subjectDenoter("zh", "丈人"),
        counterpartDenoter("zh", "儿媳"),
        counterpartDenoter("zh", "儿媳妇"),
        counterpartDenoter("zh", "女婿"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.inLawOf,
      locale: "en",
      label: "In-law (elder generation first)",
      definition:
        "Directed relation, canonical subject = elder generation. “My mother-in-law” is itself direct evidence, with no derivation through the spouse chain; closure talk about a sibling's spouse creates no Self claim.",
      positiveExamples: [
        "My mother-in-law cooked a huge dinner this weekend.",
        "Our daughter-in-law moved in last month; the kids are happy.",
      ],
      negativeExamples: [
        "My brother-in-law's parents visit next month. — two-hop closure, no Self claim",
        "Her mom is basically my future mother-in-law. — no engagement, no in-law status yet",
      ],
      lexicalSurfaces: [
        subjectDenoter("en", "mother-in-law"),
        subjectDenoter("en", "father-in-law"),
        counterpartDenoter("en", "daughter-in-law"),
        counterpartDenoter("en", "son-in-law"),
      ],
    },

    // ── sh.relationship.teacher_of ─────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.teacherOf,
      locale: "zh",
      label: "师生关系（老师方）",
      definition:
        "directed：canonical subject=老师方。学段或科目信息放 scope（如钢琴老师、中学班主任），不进 Predicate ID 或 Claim identity；“以前教过我”等历史形态按已结束投影。",
      positiveExamples: [
        "王老师是我女儿的班主任，特别负责。",
        "我是李阿姨的钢琴学生，每周六上课。",
      ],
      negativeExamples: [
        "那位健身教练训练强度很大。——运动教练不在 v1 师生定义内，unmapped 处理",
        "我常看一位老师的网课，但没跟他说过话。——单向听课不构成师生关系认证",
      ],
      lexicalSurfaces: [
        subjectDenoter("zh", "老师"),
        subjectDenoter("zh", "班主任"),
        counterpartDenoter("zh", "学生"),
        subjectDenoter("zh", "启蒙老师", "former"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.teacherOf,
      locale: "en",
      label: "Teacher–student (teacher side)",
      definition:
        "Directed relation, canonical subject = the teacher. Grade level or subject goes into scope (piano teacher, homeroom teacher) and never into the predicate ID.",
      positiveExamples: [
        "Mr. Wang is my daughter's homeroom teacher.",
        "I study piano weekly — Ms. Li is my piano teacher.",
      ],
      negativeExamples: [
        "My gym coach pushes me hard. — coaching is out of v1 scope, stays unmapped",
        "I watch her recorded lectures without contact. — one-way viewing is not a confirmed teaching bond",
      ],
      lexicalSurfaces: [
        subjectDenoter("en", "teacher"),
        counterpartDenoter("en", "student"),
      ],
    },

    // ── sh.relationship.roommate_of ─────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.roommateOf,
      locale: "zh",
      label: "室友关系",
      definition:
        "对称的同住关系，v1 无附加 Qualifier。搬走即结束：以“前室友”former 形态投影，关系重启复用原 logical Claim。",
      positiveExamples: [
        "我室友来自成都，我们约好周末一起做大扫除。",
        "大学四年我一直和室友小蒋一间宿舍。",
      ],
      negativeExamples: [
        "隔壁租户经常深夜弹琴。——同楼栋不同住处不构成室友",
        "前台阿姨是我房东介绍的帮工。——转介关系不属于任何已发布条目",
      ],
      lexicalSurfaces: [peer("zh", "室友"), peer("zh", "前室友", "former")],
    },
    {
      predicateId: PREDICATE_IDS.roommateOf,
      locale: "en",
      label: "Roommate",
      definition:
        "Symmetric cohabitation, no structured qualifiers in v1. Moving out ends it: projection switches to former form; restarts reuse the original logical claim.",
      positiveExamples: [
        "My roommate is from Chengdu; we deep-clean on weekends.",
        "Sam and I shared a dorm room all four years.",
      ],
      negativeExamples: [
        "The guy upstairs plays piano at midnight. — same building is not shared housing",
        "Our landlord sent a handyman over. — referrals belong to no published predicate",
      ],
      lexicalSurfaces: [
        peer("en", "roommate"),
        peer("en", "flatmate"),
        peer("en", "ex-roommate", "former"),
      ],
    },

    // ── sh.work.employer ────────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.employer,
      locale: "zh",
      label: "任职机构",
      definition:
        "用户当前或曾经的任职机构名称文本。单值，历史走版本；不说出机构名的笼统表述不强行落值，归 Evidence 继续观察。",
      positiveExamples: [
        "我现在在深圳一家芯片公司上班。",
        "我去年入职了字节跳动，节奏很快。",
      ],
      negativeExamples: [
        "我在考虑要不要换个行业看看机会。——意向不构成任职事实",
        "这家公司的产品我用了很多年。——使用产品不是任职机构",
      ],
      lexicalSurfaces: [
        peer("zh", "上班"),
        peer("zh", "入职"),
        peer("zh", "公司"),
        peer("zh", "雇主"),
        peer("zh", "东家"),
        peer("zh", "离职", "former"),
        peer("zh", "跳槽", "former"),
        ...WORK_CONTEXT_RETRIEVAL_ALIASES_ZH,
      ],
    },
    {
      predicateId: PREDICATE_IDS.employer,
      locale: "en",
      label: "Employer",
      definition:
        "Institution name the user works(ed) at; single valued, history via versions. Vague statements without a name stay as Evidence rather than forcing a value.",
      positiveExamples: [
        "I work at a chip company in Shenzhen.",
        "I joined Byteplus last year — pace is intense.",
      ],
      negativeExamples: [
        "I might switch industries soon. — intent is not employment fact",
        "I've used their products for years. — being a customer is not being employed",
      ],
      lexicalSurfaces: [
        peer("en", "work at"),
        peer("en", "works at"),
        peer("en", "joined"),
        peer("en", "employer"),
        peer("en", "left", "former"),
        ...WORK_CONTEXT_RETRIEVAL_ALIASES_EN,
      ],
    },

    // ── sh.work.role_title ─────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.roleTitle,
      locale: "zh",
      label: "职务头衔",
      definition:
        "用户职务短文本（如产品设计师）。单值时间性。具体职责描述留 Evidence；词面须含职位类标记避免与其他领域误挂。",
      positiveExamples: [
        "我的职位是高级测试工程师。",
        "我目前的岗位是平台组的资深前端工程师。",
      ],
      negativeExamples: [
        "我在家刷了一天简历。——活动叙述不含职位",
        "我的领导职位比我高两级。——这是他人职级陈述，非本人头衔",
      ],
      lexicalSurfaces: [
        peer("zh", "职位"),
        peer("zh", "头衔"),
        peer("zh", "岗位"),
        peer("zh", "title"),
        ...WORK_CONTEXT_RETRIEVAL_ALIASES_ZH,
      ],
    },
    {
      predicateId: PREDICATE_IDS.roleTitle,
      locale: "en",
      label: "Role title",
      definition:
        "Short job-title text (“product designer”). Single valued over time; detailed duties stay as Evidence.",
      positiveExamples: [
        "My title is senior QA engineer.",
        "I work as a product designer on the growth team.",
      ],
      negativeExamples: [
        "I polished my resume all day. — activity narration carries no title",
        "My boss's grade is two levels above mine. — describes the other person",
      ],
      lexicalSurfaces: [
        peer("en", "title"),
        peer("en", "work as"),
        peer("en", "position"),
        ...WORK_CONTEXT_RETRIEVAL_ALIASES_EN,
      ],
    },

    // ── sh.project.participation ────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.projectParticipation,
      locale: "zh",
      label: "项目参与",
      definition:
        "多值：用户参与的项目名为值文本，一个项目一条独立成立。口头口号式的宏大想法不算参与；已收尾项目走 ended 时间性。",
      positiveExamples: [
        "我现在负责家里跨境小程序的前端部分，是这个项目的负责人之一。",
        "我们团队在做智能客服项目，我被拉进去做评测。",
      ],
      negativeExamples: [
        "我梦想以后做个改变世界的产品。——愿景不等于在研项目",
        "那个项目的命名会我旁听过一次。——单次旁听太弱，先留 Evidence 观察",
      ],
      lexicalSurfaces: [
        peer("zh", "项目"),
        peer("zh", "负责"),
        peer("zh", "参与"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.projectParticipation,
      locale: "en",
      label: "Project participation",
      definition:
        "Multi-valued: each participated project is its own independently valid value. Aspirational ideas don't count; finished projects age out as ended.",
      positiveExamples: [
        "I'm on the smart-replies project doing eval work.",
        "I own the frontend for our cross-border mini-app project.",
      ],
      negativeExamples: [
        "Someday I'd love to build something world-changing. — vision is not participation",
        "I once sat in on that kickoff. — one passive session stays Evidence-only",
      ],
      lexicalSurfaces: [
        peer("en", "project"),
        peer("en", "working on"),
        peer("en", "own the"),
      ],
    },

    // ── sh.place.residence ─────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.residence,
      locale: "zh",
      label: "居住地",
      definition:
        "当前居住城市/区域文本。单值时间性；精度保留——说到区就存区，说搬家立刻开新版本；旅行与出差不改变居住地。",
      positiveExamples: [
        "我住在杭州滨江，通勤靠地铁。",
        "上个月我们把家搬去了苏州园区。",
      ],
      negativeExamples: [
        "这周出差去北京一趟。——差旅不构成居住变化",
        "我想将来搬去大理生活。——愿望不是现状",
      ],
      lexicalSurfaces: [
        peer("zh", "住在"),
        peer("zh", "定居"),
        peer("zh", "搬去"),
        peer("zh", "搬到了"),
        peer("zh", "家住"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.residence,
      locale: "en",
      label: "Residence",
      definition:
        "Current city/area of residence, single valued with precision preserved (district-level stays district-level); moving starts a new version; travel never changes it.",
      positiveExamples: [
        "I live in Hangzhou's Binjiang district.",
        "We moved to Suzhou Industrial Park last month.",
      ],
      negativeExamples: [
        "Flying to Beijing for the week on business. — travel is not relocation",
        "Dreaming of retiring to Dali someday. — wishes are not current facts",
      ],
      lexicalSurfaces: [
        peer("en", "live in"),
        peer("en", "lives in"),
        peer("en", "moved to"),
        peer("en", "based in"),
      ],
    },

    // ── sh.place.hometown ─────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.hometown,
      locale: "zh",
      label: "家乡",
      definition:
        "长期稳定的家乡地名，与居住地各自独立成立。精确到哪级存哪级；口音与籍贯讨论需本人明确说明才成文。",
      positiveExamples: [
        "我老家在四川绵阳，过年才回去。",
        "我的家乡是江苏南通。",
      ],
      negativeExamples: [
        "我这趟是回老家办事？不对，其实是回自己长大的外婆家探望。——此处“老家”指探望目的地，归属仍需澄清，不硬落家乡",
        "温州的东西超好吃，感觉上辈子是温州人。——玩笑不算籍贯自述",
      ],
      lexicalSurfaces: [peer("zh", "老家"), peer("zh", "家乡"), peer("zh", "籍贯")],
    },
    {
      predicateId: PREDICATE_IDS.hometown,
      locale: "en",
      label: "Hometown",
      definition:
        "Long-term stable hometown name, independent of current residence. Precision preserved; accent or heritage chat alone never pins it down.",
      positiveExamples: [
        "My hometown is Mianyang in Sichuan; I only go back for New Year.",
        "I grew up in Nantong, Jiangsu.",
      ],
      negativeExamples: [
        "Joking that I was Cantonese in a past life. — jokes are not provenance statements",
        "Visiting my grandma's town where I spent summers. — childhood summers are not hometown",
      ],
      lexicalSurfaces: [peer("en", "hometown"), peer("en", "grew up in")],
    },

    // ── sh.place.workplace ─────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.workplace,
      locale: "zh",
      label: "办公地点",
      definition:
        "多值支持跨城：实际日常办公地点（园区/楼宇/城市）。与任职机构分开成立——机构唯一、地点可多处；临时拜访客户现场不计入。",
      positiveExamples: [
        "我们的办公室在深圳湾科技园那边。",
        "我一周三天去上海的办公地点，其余远程。",
      ],
      negativeExamples: [
        "这季度要去杭州出差见几拨客户。——出差地点不入常驻办公地",
        "我司总部在北京，但我没去过几次。——集团总部不必然是个人的办公地点",
      ],
      lexicalSurfaces: [
        peer("zh", "办公室"),
        peer("zh", "工位"),
        peer("zh", "常驻"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.workplace,
      locale: "en",
      label: "Workplace location",
      definition:
        "Multi-valued actual daily office locations (park/building/city), supporting multi-city weeks. Independent of employer; client-site visits don't count.",
      positiveExamples: [
        "Our office is in Shenzhen Bay Science Park.",
        "I'm in the Shanghai office three days a week.",
      ],
      negativeExamples: [
        "Client visits take me to Hangzhou this quarter. — travel sites aren't a home office",
        "HQ is in Beijing though I've barely been. — company HQ isn't automatically your workplace",
      ],
      lexicalSurfaces: [
        peer("en", "office"),
        peer("en", "on-site at"),
      ],
    },

    // ── sh.plan.life_change ────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.lifeChange,
      locale: "zh",
      label: "人生阶段计划",
      definition:
        "周以上跨度的主动人生计划。scope=封闭类别（搬家/换工作/深造备考/备婚/创业/跨国迁移）；value=用户原意的客观简述+可选目标时间并保留精度。同类别单值，变化开新版本；几天内待办归 Open Loop，旅行归 Episode，禁入 Portrait。",
      positiveExamples: [
        "我们定好十一月初搬家，新房在城西已经签了。",
        "我决定辞职创业， 注册流程这周开始办。",
      ],
      negativeExamples: [
        "记得后天下午取护照然后去面签。——几天内的待办归 Open Loop，不是人生计划",
        "五一去云南玩七天早订好了。——旅行归 Episode，不入本条目",
      ],
      lexicalSurfaces: [
        peer("zh", "搬家"),
        peer("zh", "换工作"),
        peer("zh", "跳槽"),
        peer("zh", "备考"),
        peer("zh", "备婚"),
        peer("zh", "创业"),
        peer("zh", "移居"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.lifeChange,
      locale: "en",
      label: "Life-stage plan",
      definition:
        "Deliberate life plans spanning at least a week. Scope is a closed category (moving house, job change, exam prep, wedding prep, starting a business, relocating abroad); value is an objective restatement preserving any stated precision. Short-horizon to-dos are Open Loops; trips are Episodes; never enters Portrait.",
      positiveExamples: [
        "We're moving house in early November — lease signed in the west end.",
        "I've decided to quit and start my own company; paperwork begins this week.",
      ],
      negativeExamples: [
        "Reminder: pick up my passport Tuesday for the visa interview. — a short-horizon to-do is an Open Loop",
        "Booked seven days in Yunnan for May. — trips are Episodes, not life-stage plans",
      ],
      lexicalSurfaces: [
        peer("en", "moving house"),
        peer("en", "moving"),
        peer("en", "job change"),
        peer("en", "exam prep"),
        peer("en", "wedding prep"),
        peer("en", "start my own company"),
        peer("en", "relocating abroad"),
      ],
    },

    // ── sh.life.career_stage ───────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.careerStage,
      locale: "zh",
      label: "职业阶段",
      definition:
        "封闭枚举：在读/在职/求职中/自由职业/退休。单值时间性，阶段切换开新版本；只标阶段本身，不推测收入或职级高低。",
      positiveExamples: [
        "我目前在职，一边上班一边带娃。",
        "毕业后一直自由职业，接设计外包。",
      ],
      negativeExamples: [
        "我做了一上午表格好累。——任务叙述不含阶段信息",
        "羡慕那些财务自由的极客。——wishful 表达不自证状态",
      ],
      lexicalSurfaces: [
        peer("zh", "在职"),
        peer("zh", "在读"),
        peer("zh", "求职中"),
        peer("zh", "自由职业"),
        peer("zh", "退休"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.careerStage,
      locale: "en",
      label: "Career stage",
      definition:
        "Closed enum: studying / employed / job hunting / freelancing / retired. Single valued across time; stage transitions version the claim. The stage only — never income or seniority guesses.",
      positiveExamples: [
        "I'm employed full-time while raising a toddler.",
        "I've been freelancing since graduation, mostly design gigs.",
      ],
      negativeExamples: [
        "Spreadsheets all morning — so tired. — task talk reveals no stage",
        "Financial-freedom hackers are goals. — aspirational chatter self-certifies nothing",
      ],
      lexicalSurfaces: [
        peer("en", "employed"),
        peer("en", "studying"),
        peer("en", "job hunting"),
        peer("en", "freelancing"),
        peer("en", "retired"),
      ],
    },

    // ── sh.life.family_stage ───────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.familyStage,
      locale: "zh",
      label: "家庭阶段",
      definition:
        "封闭枚举：单身/恋爱中/已婚/新手父母/学龄父母/照护中。单值时间性；与职业阶段互相独立成立，互不推导。",
      positiveExamples: [
        "我单身很久了，已经习惯一个人过日子。",
        "娃刚满月，我俩正式升级成新手父母。",
      ],
      negativeExamples: [
        "帮姐姐带了两天孩子累瘫了。——偶发照护行为不等于照护阶段",
        "电视剧里的夫妻吵架看得我心累。——观剧感想无关自身家庭阶段",
      ],
      lexicalSurfaces: [
        peer("zh", "单身"),
        peer("zh", "恋爱中"),
        peer("zh", "已婚"),
        peer("zh", "新手父母"),
        peer("zh", "照护中"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.familyStage,
      locale: "en",
      label: "Family stage",
      definition:
        "Closed enum: single / dating / married / new parent / school-age parent / caregiving. Independent of career stage; neither implies the other.",
      positiveExamples: [
        "I've been single for ages and I'm used to it.",
        "Baby turned one month old — officially new parents now.",
      ],
      negativeExamples: [
        "Watched my sister's kids for two days, exhausted. — occasional babysitting is not the caregiving stage",
        "That TV couple fight hit hard. — reactions to fiction say nothing about family stage",
      ],
      lexicalSurfaces: [
        peer("en", "single"),
        peer("en", "dating"),
        peer("en", "married"),
        peer("en", "new parents"),
        peer("en", "caregiving"),
      ],
    },

    // ── sh.preference.relationship_horizon ─────────────────────────────
    {
      predicateId: PREDICATE_IDS.relationshipHorizon,
      locale: "zh",
      label: "关系预期（长期取向）",
      definition:
        "枚举型偏好：期望认真长期关系（long_term）。封闭集合，出现其它取向表述时 fail closed 转 unmapped→review，由治理决定是否扩枚举；敏感边界外的中性偏好主题。",
      positiveExamples: [
        "我想找一段长期稳定、认真的关系。",
        "比起广泛社交，我更想要能细水长流的长期陪伴。",
      ],
      negativeExamples: [
        "到现在还没想好要不要开始一段感情。——未表态不落任何枚举值",
        "只想随便认识些新朋友。——开放社交取向无对应枚举拼写，fail closed",
      ],
      lexicalSurfaces: [peer("zh", "长期"), peer("zh", "长期稳定"), peer("zh", "认真的关系")],
    },
    {
      predicateId: PREDICATE_IDS.relationshipHorizon,
      locale: "en",
      label: "Relationship horizon",
      definition:
        "Enum preference: seeking a serious long-term bond (long_term). Closed set: other horizons fail closed into unmapped→review instead of guessing a near meaning.",
      positiveExamples: [
        "I want something long term and serious.",
        "Rather than wide socializing, I hope for one steady long-term companion.",
      ],
      negativeExamples: [
        "Haven't decided if I want to date at all. — non-commitment maps to nothing",
        "Just here to meet fun new people. — open-social phrasing has no enum spelling; fail closed",
      ],
      lexicalSurfaces: [
        peer("en", "long term"),
        peer("en", "long-term"),
        peer("en", "serious relationship"),
      ],
    },

    // ── sh.preference.business_travel ─────────────────────────────────
    {
      predicateId: PREDICATE_IDS.businessTravel,
      locale: "zh",
      label: "出差偏好",
      definition:
        "情感型偏好：对工作出差的正面/负面态度（positive/negative 两极，无中性值）。只是一次抱怨不算稳定态度，需正常准入门槛。",
      positiveExamples: [
        "我还挺享受出差的，换个城市干活反而专注。",
        "我已经非常讨厌出差了，高铁坐到腰疼。",
      ],
      negativeExamples: [
        "这次航班延误太倒霉了。——单次事件情绪不是出差态度",
        "同事被派去新疆支援，他要离开一个月。——他人的安排与我的偏好无关",
      ],
      lexicalSurfaces: [peer("zh", "出差"), peer("zh", "飞")],
    },
    {
      predicateId: PREDICATE_IDS.businessTravel,
      locale: "en",
      label: "Business-travel preference",
      definition:
        "Sentiment preference toward business travel (positive/negative polarities, no neutral). A single complaint is an event, not yet a stance — normal admission gates apply.",
      positiveExamples: [
        "Honestly I enjoy business trips — new cities help me focus.",
        "I hate flying for work; trains wreck my back.",
      ],
      negativeExamples: [
        "This flight delay is such bad luck. — one-off gripe, not a stance",
        "My teammate got posted to Xinjiang for a month. — his assignment says nothing about me",
      ],
      lexicalSurfaces: [
        peer("en", "business travel"),
        peer("en", "business trips"),
        peer("en", "flying for work"),
      ],
    },

    // ── sh.communication.stated_style ──────────────────────────────────
    {
      predicateId: PREDICATE_IDS.statedStyle,
      locale: "zh",
      label: "自述沟通风格",
      definition:
        "双开条目：“我喜欢直接一点”这类直接陈述按 objective+confirmed 成立；AI 从多日跨会话观察到的一致风格按 impression+inferred 成立。单值；临时情绪与一次性事件不入。",
      positiveExamples: [
        "跟我说话你直接一点就行，我喜欢直接的沟通方式。",
        "我不太喜欢绕弯子，有意见请直说。",
      ],
      negativeExamples: [
        "我今天心情不好，说话冲了点别介意。——一次性情绪状态不属风格",
        "我老板开会喜欢抓重点。——描述他人风格不落 Self 条目",
      ],
      lexicalSurfaces: [
        peer("zh", "直接"),
        peer("zh", "直说"),
        peer("zh", "沟通方式"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.statedStyle,
      locale: "en",
      label: "Stated communication style",
      definition:
        "Dual-kind entry: “please be direct with me” confirms objectively on one statement; consistent cross-session observation yields an inferred impression. Single valued; moods and one-offs excluded.",
      positiveExamples: [
        "Please be direct with me — I prefer straightforward communication.",
        "I don't like beating around the bush; tell me if something's wrong.",
      ],
      negativeExamples: [
        "I'm cranky today, don't mind my tone. — a passing mood is not style",
        "My manager likes cutting to the chase. — describing others maps nowhere here",
      ],
      lexicalSurfaces: [
        peer("en", "be direct"),
        peer("en", "straightforward communication"),
        peer("en", "communication style"),
      ],
    },

    // ── sh.value.core_priorities ───────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.corePriorities,
      locale: "zh",
      label: "核心在意的事",
      definition:
        "印象条目：用户反复表现出的价值优先项（多值，每项独立成立）。只吸收跨会话一致的信号；敏感解释边界零条目，统一 30 天 dormant 复核。",
      positiveExamples: [
        "这周推掉了所有饭局，就想多点时间陪爸妈——家人对我来说永远排第一。",
        "比起涨薪，能否学到东西才是我看工作最重要的一点。",
      ],
      negativeExamples: [
        "今天老板夸我了开心一天。——单日情绪事件不构成长期价值取向",
        "这本小说主角的坚持让我泪目。——文艺共鸣不是自身价值观陈述",
      ],
      lexicalSurfaces: [
        peer("zh", "最重要"),
        peer("zh", "排第一"),
        peer("zh", "优先"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.corePriorities,
      locale: "en",
      label: "Core priorities",
      definition:
        "Impression entry: recurring value priorities (multi-valued, each standing alone). Cross-session consistency only; zero sensitive-domain entries here; uniform 30-day dormant review.",
      positiveExamples: [
        "Turned down every dinner this week to be with my parents — family comes first for me.",
        "Learning beats salary bumps; growth matters most when I pick jobs.",
      ],
      negativeExamples: [
        "Boss praised me today — grinning all day. — one-day mood, not a value pattern",
        "That novel's hero made me cry. — artistic resonance is not one's own priority",
      ],
      lexicalSurfaces: [
        peer("en", "comes first"),
        peer("en", "matters most"),
        peer("en", "prioritize"),
      ],
    },

    // ── sh.decision.consideration_style ────────────────────────────────
    {
      predicateId: PREDICATE_IDS.considerationStyle,
      locale: "zh",
      label: "决策考量风格",
      definition:
        "印象条目：做主要决定时的考量方式（单值）。仅印象推断路径成立，需全局两条独立 Evidence、两个 Daily Session 下限后准入。",
      positiveExamples: [
        "买不买房这事我们全家吵了三回——我做重大决定习惯把家人意见放在天平最重的一侧。",
        "挑 offer 时我会列一张利弊清单逐项打分再决定。",
      ],
      negativeExamples: [
        "中午随便点了份外卖。——低风险决定不反映决策风格",
        "他做选择特别果断真羡慕。——他人特质与我无关",
      ],
      lexicalSurfaces: [
        peer("zh", "做决定"),
        peer("zh", "重大决定"),
        peer("zh", "利弊清单"),
      ],
    },
    {
      predicateId: PREDICATE_IDS.considerationStyle,
      locale: "en",
      label: "Decision consideration style",
      definition:
        "Impression entry: how the user weighs big decisions (single valued). Impression path only — global floor of two independent pieces of Evidence across two Daily Sessions before admission.",
      positiveExamples: [
        "We argued three times over buying a flat — for big decisions my family's take tips my scale the most.",
        "When comparing offers I make a scored list of pros and cons before deciding.",
      ],
      negativeExamples: [
        "Ordered random takeout for lunch. — low-stakes picks reveal nothing about decision style",
        "He decides so decisively, I envy that. — his trait is not mine",
      ],
      lexicalSurfaces: [
        peer("en", "big decisions"),
        peer("en", "making decisions"),
        peer("en", "pros and cons"),
      ],
    },
  ];
  return Object.freeze(
    locs.map((loc) => ({ ...loc, localizationVersion: V })),
  );
}

export function buildProjectionsV1(): readonly RelationshipProjectionLocalization[] {
  const P = (
    predicateId: string,
    locale: "zh" | "en",
    viewDirection: RelationshipProjectionLocalization["viewDirection"],
    templates: string[],
    formerTemplates: string[],
  ): RelationshipProjectionLocalization => ({
    predicateId,
    locale,
    viewDirection,
    templates: Object.freeze(templates),
    formerTemplates: Object.freeze(formerTemplates),
    roleProjectionVersion: V,
  });

  return Object.freeze([
    // partner_of（symmetric）
    P(PREDICATE_IDS.partnerOf, "zh", "symmetric", ["{subject}是{object}的伴侣", "{object}是{subject}的伴侣"], ["{subject}曾是{object}的伴侣（关系已结束）"]),
    P(PREDICATE_IDS.partnerOf, "en", "symmetric", ["{subject} is {object}'s partner"], ["{subject} used to be {object}'s partner"]),
    // parent_of（directed forward: parent→child）
    P(PREDICATE_IDS.parentOf, "zh", "forward", ["{subject}是{object}的家长"], ["{subject}曾是{object}的监护人（关系已结束）"]),
    P(PREDICATE_IDS.parentOf, "zh", "inverse", ["{object}是{subject}的孩子"], ["{subject}曾是{object}家长照顾的孩子"]),
    P(PREDICATE_IDS.parentOf, "en", "forward", ["{subject} is {object}'s parent"], ["{subject} was previously {object}'s guardian"]),
    P(PREDICATE_IDS.parentOf, "en", "inverse", ["{object} is {subject}'s child"], ["{subject} formerly raised {object}"]),
    // sibling_of（symmetric）
    P(PREDICATE_IDS.siblingOf, "zh", "symmetric", ["{subject}是{object}的手足"], ["{subject}与{object}曾以手足相称（关系已疏远）"]),
    P(PREDICATE_IDS.siblingOf, "en", "symmetric", ["{subject} is {object}'s sibling"], ["{subject} and {object} were estranged siblings"]),
    // friend_of（symmetric，含两轴中性 fallback 投影）
    P(PREDICATE_IDS.friendOf, "zh", "symmetric", ["{subject}是{object}的朋友", "{subject}是{object}的好朋友"], ["{subject}曾是{object}的朋友，如今联系渐少"]),
    P(PREDICATE_IDS.friendOf, "en", "symmetric", ["{subject} is {object}'s friend", "{subject} is a good friend of {object}'s"], ["{subject} and {object} used to be friends"]),
    // colleague_of（symmetric）
    P(PREDICATE_IDS.colleagueOf, "zh", "symmetric", ["{subject}是{object}的同事"], ["{subject}曾是{object}的同事（前同事）"]),
    P(PREDICATE_IDS.colleagueOf, "en", "symmetric", ["{subject} is {object}'s colleague"], ["{subject} used to be {object}'s colleague"]),
    // manager_of（directed forward: manager→subordinate）
    P(PREDICATE_IDS.managerOf, "zh", "forward", ["{subject}是{object}的上司（经理方）"], ["{subject}曾是{object}的上司"]),
    P(PREDICATE_IDS.managerOf, "zh", "inverse", ["{object}是{subject}的下属"], ["{object}曾是{subject}汇报的前下属"]),
    P(PREDICATE_IDS.managerOf, "en", "forward", ["{subject} manages {object}"], ["{subject} previously managed {object}"]),
    P(PREDICATE_IDS.managerOf, "en", "inverse", ["{object} reports to {subject}"], ["{object} previously reported to {subject}"]),
    // relative_of（symmetric，kinship_term 中性 fallback=亲戚）
    P(PREDICATE_IDS.relativeOf, "zh", "symmetric", ["{subject}是{object}的亲戚", "{subject}与{object}是亲属"], ["{subject}与{object}曾有亲属往来（现已疏远）"]),
    P(PREDICATE_IDS.relativeOf, "en", "symmetric", ["{subject} is {object}'s relative"], ["{subject} and {object} were once in contact as relatives"]),
    // in_law_of（directed forward: elder→junior）
    P(PREDICATE_IDS.inLawOf, "zh", "forward", ["{subject}是{object}这一辈的长辈（姻亲，如配偶家长）"], ["{subject}曾是{object}家的姻亲长辈（婚约关系已结束）"]),
    P(PREDICATE_IDS.inLawOf, "zh", "inverse", ["{object}是{subject}的晚辈姻亲"], ["{object}曾是{subject}家的姻亲晚辈"]),
    P(PREDICATE_IDS.inLawOf, "en", "forward", ["{subject} is {object}'s in-law elder"], ["{subject} used to be {object}'s in-law by marriage"]),
    P(PREDICATE_IDS.inLawOf, "en", "inverse", ["{object} is {subject}'s junior in-law"], ["{object} was formerly {subject}'s in-law by marriage"]),
    // teacher_of（directed forward: teacher→student）
    P(PREDICATE_IDS.teacherOf, "zh", "forward", ["{subject}教过{object}", "{subject}是{object}的老师"], ["{subject}曾是{object}的老师（教学已结束）"]),
    P(PREDICATE_IDS.teacherOf, "zh", "inverse", ["{object}是{subject}的学生"], ["{object}曾是{subject}带过的学生"]),
    P(PREDICATE_IDS.teacherOf, "en", "forward", ["{subject} teaches {object}"], ["{subject} used to teach {object}"]),
    P(PREDICATE_IDS.teacherOf, "en", "inverse", ["{object} studies under {subject}"], ["{object} was formerly {subject}'s student"]),
    // roommate_of（symmetric，含前室友 former 形态）
    P(PREDICATE_IDS.roommateOf, "zh", "symmetric", ["{subject}是{object}的室友"], ["{subject}曾是{object}的室友（前室友）"]),
    P(PREDICATE_IDS.roommateOf, "en", "symmetric", ["{subject} is {object}'s roommate"], ["{subject} is {object}'s ex-roommate"]),
  ]);
}

export function buildRelationsV1List(): readonly PredicateRelation[] {
  const c = (
    a: string,
    b: string,
  ): PredicateRelation => ({
    predicateId: a,
    relatedPredicateId: b,
    relationType: "confusable_with",
  });
  return Object.freeze([
    c(PREDICATE_IDS.managerOf, PREDICATE_IDS.colleagueOf),
    c(PREDICATE_IDS.colleagueOf, PREDICATE_IDS.managerOf),
    c(PREDICATE_IDS.parentOf, PREDICATE_IDS.relativeOf),
    c(PREDICATE_IDS.relativeOf, PREDICATE_IDS.parentOf),
    c(PREDICATE_IDS.partnerOf, PREDICATE_IDS.siblingOf),
    c(PREDICATE_IDS.siblingOf, PREDICATE_IDS.partnerOf),
    c(PREDICATE_IDS.friendOf, PREDICATE_IDS.colleagueOf),
    c(PREDICATE_IDS.colleagueOf, PREDICATE_IDS.friendOf),
    c(PREDICATE_IDS.employer, PREDICATE_IDS.workplace),
    c(PREDICATE_IDS.workplace, PREDICATE_IDS.employer),
    c(PREDICATE_IDS.careerStage, PREDICATE_IDS.employer),
    c(PREDICATE_IDS.employer, PREDICATE_IDS.careerStage),
    c(PREDICATE_IDS.relativeOf, PREDICATE_IDS.inLawOf),
    c(PREDICATE_IDS.inLawOf, PREDICATE_IDS.relativeOf),
    c(PREDICATE_IDS.siblingOf, PREDICATE_IDS.relativeOf),
    c(PREDICATE_IDS.relativeOf, PREDICATE_IDS.siblingOf),
    c(PREDICATE_IDS.familyStage, PREDICATE_IDS.partnerOf),
    c(PREDICATE_IDS.partnerOf, PREDICATE_IDS.familyStage),
    c(PREDICATE_IDS.residence, PREDICATE_IDS.hometown),
    c(PREDICATE_IDS.hometown, PREDICATE_IDS.residence),
    c(PREDICATE_IDS.workplace, PREDICATE_IDS.residence),
    c(PREDICATE_IDS.residence, PREDICATE_IDS.workplace),
    c(PREDICATE_IDS.roleTitle, PREDICATE_IDS.careerStage),
    c(PREDICATE_IDS.careerStage, PREDICATE_IDS.roleTitle),
  ]);
}
