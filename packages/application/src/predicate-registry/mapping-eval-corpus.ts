import {
  type MappingOutcome,
  type PredicateRegistrySnapshot,
  PREDICATE_IDS as IDS,
  loadPredicateRegistrySnapshot,
} from "./index";

import {
  canonicalRelationshipKey,
  mapUtterance,
  mapUtteranceCodeSwitch,
  validateMappingProposal,
} from "./mapper";

/**
 * Cross-locale mapping-eval corpus (#93 §8): the authoritative fixture set for
 * Predicate Registry v2. Consumed by BOTH the CI matrix suite
 * (mapping-eval.matrix.test.ts) and the frozen-model replay script
 * (eval/predicate-registry-v1/replay.mts). The replay script can pin the
 * historical v1 subset so the old release remains reproducible.
 */

const v2 = loadPredicateRegistrySnapshot(2);

export type ForwardCase = {
  mode: "zh" | "en" | "cs";
  text: string;
  /** Cases added after v1 are excluded from the v1 compatibility replay. */
  minimumRegistryVersion?: number;
  expect: {
    predicateId: string;
    typedValue?: string;
    scopeValue?: string;
    form?: "current" | "former";
    /** directed canonical-subject holder is the mentioned other person */
    subjectIsOther?: boolean;
    subjectIsSelf?: boolean;
    symmetricPairOf?: [string, string];
  };
};

// ─── forward corpus ────────────────────────────────────────────────────────

export const FORWARD: readonly ForwardCase[] = [
  // sh.relationship.partner_of
  {
    mode: "zh",
    text: "我和小李谈恋爱三年了，他是我男朋友。",
    expect: { predicateId: IDS.partnerOf },
  },
  {
    mode: "zh",
    text: "我老婆今天做的红烧肉真香。",
    expect: { predicateId: IDS.partnerOf },
  },
  {
    mode: "en",
    text: "Dana is my girlfriend.",
    expect: { predicateId: IDS.partnerOf },
  },
  {
    mode: "en",
    text: "My husband cooks on Sundays.",
    expect: { predicateId: IDS.partnerOf },
  },
  {
    mode: "cs",
    text: "她是我 girlfriend，我们下个月去看演唱会。",
    expect: { predicateId: IDS.partnerOf },
  },
  {
    mode: "cs",
    text: "My boyfriend 说下个月一起去苏州。他是我 boyfriend。",
    expect: { predicateId: IDS.partnerOf },
  },

  // sh.relationship.parent_of
  {
    mode: "zh",
    text: "我儿子今年刚上小学。",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },
  {
    mode: "zh",
    text: "我是我儿子的家长，他今年上小学。",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },
  {
    mode: "en",
    text: "I'm a new dad — my son just turned one.",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },
  {
    mode: "en",
    text: "My daughter started kindergarten this fall.",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },
  {
    mode: "cs",
    text: "我儿子 is starting 第一 grade next week。",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },
  {
    mode: "cs",
    text: "Weekends belong to my 女儿 now，陪她拼乐高。",
    expect: { predicateId: IDS.parentOf, subjectIsSelf: true },
  },

  // sh.relationship.sibling_of
  {
    mode: "zh",
    text: "我哥哥大我五岁，从小带我打球。",
    expect: { predicateId: IDS.siblingOf },
  },
  {
    mode: "zh",
    text: "我和我妹妹每周都视频一次。",
    expect: { predicateId: IDS.siblingOf },
  },
  {
    mode: "en",
    text: "My brother is five years older than me.",
    expect: { predicateId: IDS.siblingOf },
  },
  {
    mode: "en",
    text: "Dana and I are close — she's my sister.",
    expect: { predicateId: IDS.siblingOf },
  },
  {
    mode: "cs",
    text: "我妹妹 keeps calling me every Sunday morning。",
    expect: { predicateId: IDS.siblingOf },
  },
  {
    mode: "cs",
    text: "My brother 每次回来都抢遥控器。",
    expect: { predicateId: IDS.siblingOf },
  },

  // sh.relationship.friend_of
  {
    mode: "zh",
    text: "小周是我最好的闺蜜，什么话都能聊。",
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "zh",
    text: "老陈是我的普通朋友，打球认识的球友。",
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "en",
    text: "Anna is my bestie — we tell each other everything.",
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "en",
    text: "Ben is my casual friend from the climbing gym.",
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "cs",
    text: "她是我的 bestie 也是球友，周末总约羽毛球。",
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "cs",
    text: "John 是我的普通朋友，我们偶尔打打游戏 friend。",
    expect: { predicateId: IDS.friendOf },
  },

  // sh.relationship.colleague_of
  {
    mode: "zh",
    text: "我和她是同事，都在产品部。",
    expect: { predicateId: IDS.colleagueOf },
  },
  {
    mode: "zh",
    text: "小郑是同一组的同事。",
    expect: { predicateId: IDS.colleagueOf },
  },
  {
    mode: "en",
    text: "Rae and I are colleagues on the platform team.",
    expect: { predicateId: IDS.colleagueOf },
  },
  {
    mode: "en",
    text: "Ken joined my old team; he is my coworker now.",
    expect: { predicateId: IDS.colleagueOf },
  },
  {
    mode: "cs",
    text: "她是我的 coworker，平时用英文 standup 同事们都说。",
    expect: { predicateId: IDS.colleagueOf },
  },
  {
    mode: "cs",
    text: "我和 Ken 是同事 coworker，做同一个 project。",
    expect: { predicateId: IDS.colleagueOf },
  },

  // sh.relationship.manager_of
  {
    mode: "zh",
    text: "她是我领导，每周给我做一对一。",
    expect: { predicateId: IDS.managerOf, subjectIsOther: true },
  },
  {
    mode: "zh",
    text: "他们都是我的下属。",
    expect: { predicateId: IDS.managerOf, subjectIsSelf: true },
  },
  {
    mode: "en",
    text: "Dana is my boss — she runs weekly one-on-ones.",
    expect: { predicateId: IDS.managerOf, subjectIsOther: true },
  },
  {
    mode: "en",
    text: "They are my direct reports on the platform team.",
    expect: { predicateId: IDS.managerOf, subjectIsSelf: true },
  },
  {
    mode: "cs",
    text: "她是我 boss，KPI 都是她在带。",
    expect: { predicateId: IDS.managerOf, subjectIsOther: true },
  },
  {
    mode: "cs",
    text: "My manager 安排了明天的评审，他是我 boss。",
    expect: { predicateId: IDS.managerOf, subjectIsOther: true },
  },

  // sh.relationship.relative_of
  {
    mode: "zh",
    text: "我姑姑这个周末要从南京过来住两天。",
    expect: { predicateId: IDS.relativeOf },
  },
  {
    mode: "zh",
    text: "我表姐刚生了宝宝，我要当表舅了。",
    expect: { predicateId: IDS.relativeOf },
  },
  {
    mode: "en",
    text: "My aunt is visiting from Nanjing this weekend.",
    expect: { predicateId: IDS.relativeOf },
  },
  {
    mode: "en",
    text: "My cousin just had a baby girl.",
    expect: { predicateId: IDS.relativeOf },
  },
  {
    mode: "cs",
    text: "我 uncle 舅舅说今年春节早点回家。",
    expect: { predicateId: IDS.relativeOf },
  },
  {
    mode: "cs",
    text: "My cousin 表哥 is picking me up at 高铁站。",
    expect: { predicateId: IDS.relativeOf },
  },

  // sh.relationship.in_law_of
  {
    mode: "zh",
    text: "我婆婆周末做了一大桌子菜。",
    expect: { predicateId: IDS.inLawOf, subjectIsOther: true },
  },
  {
    mode: "zh",
    text: "我们家儿媳妇上个月刚过门。",
    expect: { predicateId: IDS.inLawOf, subjectIsSelf: true },
  },
  {
    mode: "en",
    text: "My mother-in-law cooked a huge dinner this weekend.",
    expect: { predicateId: IDS.inLawOf, subjectIsOther: true },
  },
  {
    mode: "en",
    text: "Our son-in-law helps with groceries now.",
    expect: { predicateId: IDS.inLawOf, subjectIsSelf: true },
  },
  {
    mode: "cs",
    text: "我 mother-in-law 婆婆教我做了一道汤。",
    expect: { predicateId: IDS.inLawOf, subjectIsOther: true },
  },
  {
    mode: "cs",
    text: "Our 儿媳妇 daughter-in-law moved in last month。",
    expect: { predicateId: IDS.inLawOf, subjectIsSelf: true },
  },

  // sh.relationship.teacher_of
  {
    mode: "zh",
    text: "王老师是我女儿的班主任，特别负责。",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },
  {
    mode: "zh",
    text: "我是李阿姨的钢琴学生，每周六上课。",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },
  {
    mode: "en",
    text: "Ms. Li is my piano teacher.",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },
  {
    mode: "en",
    text: "I am a student of Ms. Li for piano.",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },
  {
    mode: "cs",
    text: "钢琴老师 says 我的指法进步很大 teacher。",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },
  {
    mode: "cs",
    text: "Ms. Li 老师 my teacher 这周给我留了新曲子。",
    expect: { predicateId: IDS.teacherOf, subjectIsOther: true },
  },

  // sh.relationship.roommate_of
  {
    mode: "zh",
    text: "我室友来自成都，我们约好周末大扫除。",
    expect: { predicateId: IDS.roommateOf },
  },
  {
    mode: "zh",
    text: "老周现在是我前室友，搬走以后偶尔联系。",
    expect: { predicateId: IDS.roommateOf, form: "former" },
  },
  {
    mode: "en",
    text: "Sam is my roommate this year.",
    expect: { predicateId: IDS.roommateOf },
  },
  {
    mode: "en",
    text: "Alex is my ex-roommate from college.",
    expect: { predicateId: IDS.roommateOf, form: "former" },
  },
  {
    mode: "cs",
    text: "我 roommate 室友今晚想 hotpot 火锅。",
    expect: { predicateId: IDS.roommateOf },
  },
  {
    mode: "cs",
    text: "My 室友 roommate 总是最后一个洗澡。",
    expect: { predicateId: IDS.roommateOf },
  },

  // sh.work.employer
  {
    mode: "zh",
    text: "我现在在深圳一家芯片公司上班。",
    expect: { predicateId: IDS.employer, typedValue: "深圳一家芯片公司" },
  },
  {
    mode: "zh",
    text: "我去年入职了字节跳动，节奏很快。",
    expect: { predicateId: IDS.employer, typedValue: "字节跳动" },
  },
  {
    mode: "en",
    text: "I work at Huawei.",
    expect: { predicateId: IDS.employer, typedValue: "Huawei" },
  },
  {
    mode: "en",
    text: "I joined Byteplus last year.",
    expect: { predicateId: IDS.employer, typedValue: "Byteplus" },
  },
  {
    mode: "cs",
    text: "我刚加入了 ByteDance 这个公司，天天 standup 上班节奏飞快。",
    expect: { predicateId: IDS.employer, typedValue: "ByteDance" },
  },
  {
    mode: "cs",
    text: "我在 Tencent 上班。",
    expect: { predicateId: IDS.employer, typedValue: "Tencent" },
  },

  // sh.work.role_title
  {
    mode: "zh",
    text: "我的职位是高级测试工程师。",
    expect: { predicateId: IDS.roleTitle, typedValue: "高级测试工程师" },
  },
  {
    mode: "zh",
    text: "我目前的岗位是平台组资深前端工程师。",
    expect: { predicateId: IDS.roleTitle, typedValue: "平台组资深前端工程师" },
  },
  {
    mode: "en",
    text: "My title is senior QA engineer.",
    expect: { predicateId: IDS.roleTitle, typedValue: "senior QA engineer" },
  },
  {
    mode: "en",
    text: "I work as a product designer.",
    expect: { predicateId: IDS.roleTitle, typedValue: "product designer" },
  },
  {
    mode: "cs",
    text: "我的 title 是 Design Lead，title 就是头衔别多想。",
    expect: { predicateId: IDS.roleTitle, typedValue: "Design Lead" },
  },
  {
    mode: "cs",
    text: "我现在的岗位是 Backend Engineer 后端工程师。",
    expect: { predicateId: IDS.roleTitle, typedValue: "Backend Engineer 后端工程师" },
  },

  // sh.project.participation
  {
    mode: "zh",
    text: "我现在负责星海项目的前端部分。",
    expect: { predicateId: IDS.projectParticipation, typedValue: "星海" },
  },
  {
    mode: "zh",
    text: "我们团队在做智能客服项目，我被拉进去做评测。",
    expect: { predicateId: IDS.projectParticipation, typedValue: "智能客服" },
  },
  {
    mode: "en",
    text: "I'm on the smart replies project doing eval work.",
    expect: { predicateId: IDS.projectParticipation, typedValue: "smart replies" },
  },
  {
    mode: "en",
    text: "Working on the knowledge base project this quarter.",
    expect: { predicateId: IDS.projectParticipation, typedValue: "knowledge base" },
  },
  {
    mode: "cs",
    text: "我这季度都在参与 推荐 project 的评测。",
    expect: { predicateId: IDS.projectParticipation, typedValue: "推荐" },
  },
  {
    mode: "cs",
    text: "负责 dashboard 项目的前端部分，I own that scope。",
    expect: { predicateId: IDS.projectParticipation, typedValue: "dashboard" },
  },

  // sh.place.residence
  {
    mode: "zh",
    text: "我住在杭州滨江，通勤靠地铁。",
    expect: { predicateId: IDS.residence, typedValue: "杭州滨江" },
  },
  {
    mode: "zh",
    text: "上个月我们把家搬去了苏州园区。",
    expect: { predicateId: IDS.residence, typedValue: "苏州园区" },
  },
  {
    mode: "en",
    text: "I live in Hangzhou's Binjiang district.",
    expect: {
      predicateId: IDS.residence,
      typedValue: "Hangzhou's Binjiang district",
    },
  },
  {
    mode: "en",
    text: "We moved to Suzhou Industrial Park.",
    expect: {
      predicateId: IDS.residence,
      typedValue: "Suzhou Industrial Park",
    },
  },
  {
    mode: "cs",
    text: "现在 live in 上海浦东，通勤靠地铁。",
    expect: { predicateId: IDS.residence, typedValue: "上海浦东" },
  },
  {
    mode: "cs",
    text: "We moved to 苏州工业园区 last month。",
    expect: {
      predicateId: IDS.residence,
      typedValue: "苏州工业园区",
    },
  },

  // sh.place.hometown
  {
    mode: "zh",
    text: "我老家在四川绵阳，过年才回去。",
    expect: { predicateId: IDS.hometown, typedValue: "四川绵阳" },
  },
  {
    mode: "zh",
    text: "我的家乡是江苏南通。",
    expect: { predicateId: IDS.hometown, typedValue: "江苏南通" },
  },
  {
    mode: "en",
    text: "My hometown is Mianyang in Sichuan.",
    expect: { predicateId: IDS.hometown, typedValue: "Mianyang in Sichuan" },
  },
  {
    mode: "en",
    text: "I grew up in Nantong, Jiangsu.",
    expect: { predicateId: IDS.hometown, typedValue: "Nantong" },
  },
  {
    mode: "cs",
    text: "我的 hometown 家乡就是湖北武汉。",
    expect: { predicateId: IDS.hometown, typedValue: "湖北武汉" },
  },
  {
    mode: "cs",
    text: "I grew up in 成都 until age ten.",
    expect: { predicateId: IDS.hometown, typedValue: "成都" },
  },

  // sh.place.workplace
  {
    mode: "zh",
    text: "我们的办公室在深圳湾科技园那边。",
    expect: { predicateId: IDS.workplace, typedValue: "深圳湾科技园" },
  },
  {
    mode: "zh",
    text: "我一周三天去上海的办公地点办公，其余远程。",
    expect: { predicateId: IDS.workplace, typedValue: "上海" },
  },
  {
    mode: "en",
    text: "Our office is in Shenzhen Bay Science Park.",
    expect: {
      predicateId: IDS.workplace,
      typedValue: "Shenzhen Bay Science Park",
    },
  },
  {
    mode: "en",
    text: "I'm on-site at the Hangzhou office.",
    expect: { predicateId: IDS.workplace, typedValue: "Hangzhou office" },
  },
  {
    mode: "cs",
    text: "这周常驻 Shanghai office 那边。",
    expect: { predicateId: IDS.workplace, typedValue: "Shanghai office" },
  },
  {
    mode: "cs",
    text: "Our office is in 陆家嘴，视野很好 office。",
    expect: { predicateId: IDS.workplace, typedValue: "陆家嘴" },
  },

  // sh.plan.life_change
  {
    mode: "zh",
    text: "我们定好十一月初搬家，新房在城西已经签了。",
    expect: { predicateId: IDS.lifeChange, scopeValue: "moving_house" },
  },
  {
    mode: "zh",
    text: "我决定辞职创业，注册流程这周开始办。",
    expect: { predicateId: IDS.lifeChange, scopeValue: "starting_business" },
  },
  {
    mode: "en",
    text: "We're moving house in early November.",
    expect: { predicateId: IDS.lifeChange, scopeValue: "moving_house" },
  },
  {
    mode: "en",
    text: "Wedding prep finally started — venue booked for June.",
    expect: { predicateId: IDS.lifeChange, scopeValue: "wedding_prep" },
  },
  {
    mode: "cs",
    text: "我开始 exam prep 备考雅思了，准备明年出国。",
    expect: { predicateId: IDS.lifeChange, scopeValue: "further_study_prep" },
  },
  {
    mode: "cs",
    text: "Job change 换工作这事我们全家讨论过了，明年搬家一起办 relocating abroad。",
    expect: { predicateId: IDS.lifeChange, scopeValue: "job_change" },
  },

  // sh.life.career_stage
  {
    mode: "zh",
    text: "我目前在职，一边上班一边带娃。",
    expect: { predicateId: IDS.careerStage, typedValue: "employed" },
  },
  {
    mode: "zh",
    text: "毕业后一直自由职业，接设计外包。",
    expect: { predicateId: IDS.careerStage, typedValue: "freelance" },
  },
  {
    mode: "en",
    text: "I'm employed full-time while raising a toddler.",
    expect: { predicateId: IDS.careerStage, typedValue: "employed" },
  },
  {
    mode: "en",
    text: "I'm studying for my master's degree now.",
    expect: { predicateId: IDS.careerStage, typedValue: "enrolled_student" },
  },
  {
    mode: "cs",
    text: "我在 job hunting 找工作中，简历改了八遍。",
    expect: { predicateId: IDS.careerStage, typedValue: "job_seeking" },
  },
  {
    mode: "cs",
    text: "My grandpa retired 我爷爷退休十年了而我还在 freelancing 接活。",
    expect: { predicateId: IDS.careerStage, typedValue: "freelance" },
  },

  // sh.life.family_stage
  {
    mode: "zh",
    text: "我单身很久了，已经习惯一个人过日子。",
    expect: { predicateId: IDS.familyStage, typedValue: "single" },
  },
  {
    mode: "zh",
    text: "娃刚满月，我俩正式升级成新手父母。",
    expect: { predicateId: IDS.familyStage, typedValue: "new_parent" },
  },
  {
    mode: "en",
    text: "I've been single for ages and I'm used to it.",
    expect: { predicateId: IDS.familyStage, typedValue: "single" },
  },
  {
    mode: "en",
    text: "Baby turned one month old — officially married with a newborn.",
    expect: { predicateId: IDS.familyStage, typedValue: "married" },
  },
  {
    mode: "cs",
    text: "我最近在 dating 恋爱中，感觉还不错。",
    expect: { predicateId: IDS.familyStage, typedValue: "in_relationship" },
  },
  {
    mode: "cs",
    text: "我成了 school_age_parent 学龄父母，每天陪写作业到九点。",
    expect: { predicateId: IDS.familyStage, typedValue: "school_age_parent" },
  },

  // sh.preference.relationship_horizon
  {
    mode: "zh",
    text: "我想找一段长期稳定、认真的关系。",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },
  {
    mode: "zh",
    text: "比起广泛社交，我更想要能细水长流的长期陪伴。",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },
  {
    mode: "en",
    text: "I want something long term and serious.",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },
  {
    mode: "en",
    text: "Hoping for a long-term companion rather than wide socializing.",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },
  {
    mode: "cs",
    text: "我想找一段 long term 认真的关系稳定发展。",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },
  {
    mode: "cs",
    text: "Looking for something 长期稳定的认真关系 long-term with someone kind。",
    expect: { predicateId: IDS.relationshipHorizon, typedValue: "long_term" },
  },

  // sh.preference.business_travel
  {
    mode: "zh",
    text: "我还挺享受出差的，换个城市干活反而专注。",
    expect: { predicateId: IDS.businessTravel, typedValue: "positive" },
  },
  {
    mode: "zh",
    text: "我已经非常讨厌出差了，高铁坐到腰疼。",
    expect: { predicateId: IDS.businessTravel, typedValue: "negative" },
  },
  {
    mode: "en",
    text: "Honestly I enjoy business trips — new cities help me focus.",
    expect: { predicateId: IDS.businessTravel, typedValue: "positive" },
  },
  {
    mode: "en",
    text: "I hate flying for work; trains wreck my back.",
    expect: { predicateId: IDS.businessTravel, typedValue: "negative" },
  },
  {
    mode: "cs",
    text: "我不太喜欢 business travel 出差，家里猫离不开人。",
    expect: { predicateId: IDS.businessTravel, typedValue: "negative" },
  },
  {
    mode: "cs",
    text: "出差出 three days 出差我享受 process。",
    expect: { predicateId: IDS.businessTravel, typedValue: "positive" },
  },

  // sh.communication.stated_style
  {
    mode: "zh",
    text: "跟我说话你直接一点就行，我喜欢直接的沟通方式。",
    expect: {
      predicateId: IDS.statedStyle,
      typedValue: "我说话你直接一点就行",
    },
  },
  {
    mode: "zh",
    text: "有意见请直说。",
    expect: { predicateId: IDS.statedStyle, typedValue: "有意见请直说" },
  },
  {
    mode: "en",
    text: "Please be direct with me.",
    expect: { predicateId: IDS.statedStyle, typedValue: "Please be direct with me" },
  },
  {
    mode: "en",
    text: "I prefer straightforward communication.",
    expect: {
      predicateId: IDS.statedStyle,
      typedValue: "I prefer straightforward communication",
    },
  },
  {
    mode: "cs",
    text: "开会时请 be direct 直接一点就行，我喜欢效率。",
    expect: {
      predicateId: IDS.statedStyle,
      typedValue: "开会时请 be direct 直接一点就行",
    },
  },
  {
    mode: "cs",
    text: "I like straightforward communication 沟通方式简单点。",
    expect: {
      predicateId: IDS.statedStyle,
      typedValue: "I like straightforward communication 沟通方式简单点",
    },
  },

  // sh.value.core_priorities
  {
    mode: "zh",
    text: "家人对我来说永远排第一，其他都可以让路。",
    expect: { predicateId: IDS.corePriorities, typedValue: "家人对我来说永远排第一" },
  },
  {
    mode: "zh",
    text: "能不能学到东西才是我看工作最重要的一点。",
    expect: {
      predicateId: IDS.corePriorities,
      typedValue: "能不能学到东西才是我看工作最重要的一点",
    },
  },
  {
    mode: "en",
    text: "Family comes first for me, everything else can wait.",
    expect: {
      predicateId: IDS.corePriorities,
      typedValue: "Family comes first for me, everything else can wait",
    },
  },
  {
    mode: "en",
    text: "Growth matters most when I pick jobs.",
    expect: {
      predicateId: IDS.corePriorities,
      typedValue: "Growth matters most when I pick jobs",
    },
  },
  {
    mode: "cs",
    text: "健康 matters most 对我来说最重要。",
    expect: {
      predicateId: IDS.corePriorities,
      typedValue: "健康 matters most 对我来说最重要",
    },
  },
  {
    mode: "cs",
    text: "我觉得朋友 comes first before anything else 优先于工作。",
    expect: {
      predicateId: IDS.corePriorities,
      typedValue: "我觉得朋友 comes first before anything else 优先于工作",
    },
  },

  // sh.decision.consideration_style
  {
    mode: "zh",
    text: "我做重大决定习惯把家人意见放在天平最重的一侧。",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue: "我做重大决定习惯把家人意见放在天平最重的一侧",
    },
  },
  {
    mode: "zh",
    text: "挑 offer 时我会列一张利弊清单逐项打分再决定。",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue: "挑 offer 时我会列一张利弊清单逐项打分再决定",
    },
  },
  {
    mode: "en",
    text: "For big decisions I always build a sheet of pros and cons first.",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue:
        "For big decisions I always build a sheet of pros and cons first",
    },
  },
  {
    mode: "en",
    text: "Making decisions goes faster when my family weighs in early.",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue: "Making decisions goes faster when my family weighs in early",
    },
  },
  {
    mode: "cs",
    text: "Big decisions 的时候我会列一张 pros and cons 清单再决定利弊。",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue: "Big decisions 的时候我会列一张 pros and cons 清单再决定利弊",
    },
  },
  {
    mode: "cs",
    text: "我做决定 making decisions 之前一定先问家人的想法考虑清楚。",
    expect: {
      predicateId: IDS.considerationStyle,
      typedValue: "我做决定 making decisions 之前一定先问家人的想法考虑清楚",
    },
  },
  // Registry v2 adds state-noun English positives instead of forcing the
  // singular person noun used by the v1 fixture. These cases are intentionally
  // v2-only so a v1 replay cannot silently claim coverage it never shipped.
  {
    mode: "en",
    text: "Alex and I are friends from college.",
    minimumRegistryVersion: 2,
    expect: { predicateId: IDS.friendOf },
  },
  {
    mode: "en",
    text: "Our friendship goes back years.",
    minimumRegistryVersion: 2,
    expect: { predicateId: IDS.friendOf },
  },
];

/** The v1 corpus view used by the frozen historical replay. */
export const FORWARD_V1: readonly ForwardCase[] = Object.freeze(
  FORWARD.filter((c) => (c.minimumRegistryVersion ?? 1) <= 1),
);

/** Negatives feeding the reverse zero-tolerance gates (#93 §8). */
type ReverseGate =
  | "confusable_separation"
  | "illegal_value_fail_closed"
  | "closure_language_no_claim"
  | "deferred_concept_unmapped_with_proposal"
  | "unknown_concept_unmapped"
  | "wrong_kind_rejected";

export type ReverseCase = {
  gate: ReverseGate;
  mode: "zh" | "en" | "cs";
  text: string;
  /** For confusable cases: the outcome must NOT be this predicate. */
  forbiddenPredicateId?: string;
  /**
   * Unknown-relational-concept rows (#93 §8): pair-shaped unknowns carry a
   * governance proposal; narration with no pair shape does not.
   */
  expectedProposal?: boolean;
};

export const REVERSE: readonly ReverseCase[] = [
  // confusable separation: 她是我领导 never lands colleague; kinship bands
  // never fold into relative_of; partner terms stay off sibling.
  { gate: "confusable_separation", mode: "zh", text: "她是我领导，这次晋升她说了算。", forbiddenPredicateId: IDS.colleagueOf },
  { gate: "confusable_separation", mode: "zh", text: "我就是个普通同事，偶尔同步进度。", forbiddenPredicateId: IDS.managerOf },
  { gate: "confusable_separation", mode: "en", text: "Dana is my boss and decides promotions.", forbiddenPredicateId: IDS.colleagueOf },
  { gate: "confusable_separation", mode: "en", text: "He's just another coworker who syncs updates.", forbiddenPredicateId: IDS.managerOf },
  { gate: "confusable_separation", mode: "cs", text: "他是我 boss 兼 mentor 领导，不是什么普通 colleague。", forbiddenPredicateId: IDS.colleagueOf },
  { gate: "confusable_separation", mode: "cs", text: "他是我的 coworker 同事，不是什么领导 boss。", forbiddenPredicateId: IDS.managerOf },
  { gate: "confusable_separation", mode: "zh", text: "我妈妈这个年纪最操心了。", forbiddenPredicateId: IDS.relativeOf },
  { gate: "confusable_separation", mode: "zh", text: "我和我哥哥从小打到大的架数不清。", forbiddenPredicateId: IDS.relativeOf },
  { gate: "confusable_separation", mode: "zh", text: "我女朋友今天想吃火锅。", forbiddenPredicateId: IDS.siblingOf },
  { gate: "confusable_separation", mode: "en", text: "My mom calls me every night.", forbiddenPredicateId: IDS.relativeOf },
  { gate: "confusable_separation", mode: "en", text: "My girlfriend hates spicy food.", forbiddenPredicateId: IDS.siblingOf },
  { gate: "confusable_separation", mode: "cs", text: "My sister 姐姐借了我的充电器还没还。", forbiddenPredicateId: IDS.relativeOf },
  { gate: "confusable_separation", mode: "cs", text: "我 wife 太太说晚上吃轻食。", forbiddenPredicateId: IDS.relativeOf },
  { gate: "confusable_separation", mode: "zh", text: "我们的办公室在深圳湾，公司总部在北京。", forbiddenPredicateId: IDS.residence },
  { gate: "confusable_separation", mode: "en", text: "I'm employed full-time at the Shenzhen office.", forbiddenPredicateId: IDS.employer },
  { gate: "confusable_separation", mode: "cs", text: "我在家工作 home 在职状态挺自由 freelance 效率反而高。", forbiddenPredicateId: IDS.employer },

  // closure language and transitivity must produce NO Self claim.
  { gate: "closure_language_no_claim", mode: "zh", text: "我姐夫的爸妈下个月来玩。" },
  { gate: "closure_language_no_claim", mode: "zh", text: "她姐姐和她姐夫吵架了，两头劝。" },
  { gate: "closure_language_no_claim", mode: "en", text: "Her husband's parents visit next month." },
  { gate: "closure_language_no_claim", mode: "en", text: "My roommate's girlfriend joined us for dinner." },
  { gate: "closure_language_no_claim", mode: "cs", text: "我同事 her husband 也在这栋楼上班。" },
  { gate: "closure_language_no_claim", mode: "cs", text: "室友的 roommate roommate 的兄弟也来了 brother-in-law 那边。" },

  // deferred concepts resolve unmapped WITH a proposed concept.
  { gate: "deferred_concept_unmapped_with_proposal", mode: "zh", text: "隔壁邻居帮过我很多忙。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "zh", text: "我们是五年的合作伙伴，互相知根知底。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "zh", text: "他是我干爹家的教子，过年才见一面。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "zh", text: "房东今天来修热水器。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "zh", text: "我们现在算是暧昧吧，谁也没捅破窗户纸。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "en", text: "My neighbor helped carry my sofa upstairs." },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "en", text: "Dan has been our best client for years." },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "en", text: "My landlord raised the rent again." },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "cs", text: "我的 neighbor 邻居和我 business partner 合作伙伴都住在同小区。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "cs", text: "He is my landlord 房东，租客 tenant life is busy。" },
  { gate: "deferred_concept_unmapped_with_proposal", mode: "cs", text: "我们 client 客户关系很铁，他是我干亲 干弟弟。" },

  // unknown concepts: no published surface anywhere.
  { gate: "unknown_concept_unmapped", mode: "zh", text: "我们是搭子旅行的驴友。" },
  { gate: "unknown_concept_unmapped", mode: "zh", text: "他是我的笔友，写信二十年。" , expectedProposal: true },
  { gate: "unknown_concept_unmapped", mode: "en", text: "We're pen pals from a stamp forum." },
  { gate: "unknown_concept_unmapped", mode: "en", text: "She's my gym buddy from spin class." , expectedProposal: true },
  { gate: "unknown_concept_unmapped", mode: "cs", text: "她是我的 gym buddy 驴友，只在线下见过 pen pal 笔友一次。" , expectedProposal: true },
  { gate: "unknown_concept_unmapped", mode: "cs", text: "他是我 online 笔友 pen pal 兼 game teammate。" },

  // illegal enum values fail closed.
  { gate: "illegal_value_fail_closed", mode: "zh", text: "职业阶段填财务自由？" },
  { gate: "illegal_value_fail_closed", mode: "en", text: "Career stage: financially free?" },
  { gate: "illegal_value_fail_closed", mode: "cs", text: "Career stage 职业阶段写 passive income 或者 F.I.R.E 都不行。" },
];

/** Resolve one forward case through the deterministic pipeline. */
export function resolve(
  c: ForwardCase,
  snapshot: PredicateRegistrySnapshot = v2,
): MappingOutcome {
  if (c.mode === "cs") {
    return mapUtteranceCodeSwitch(c.text, { snapshot });
  }
  return mapUtterance({ text: c.text, locale: c.mode, snapshot });
}
