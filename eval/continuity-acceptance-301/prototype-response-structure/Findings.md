# 回应结构对照原型：结论

一次性原型的结论文件。分支 `prototype/spec-301-response-structure`（自 `f179b3d`），不合入任何分支。
数据为 2026-10-12 的真实模型运行（DeepSeek V4.1 Flash 经 OpenCode Go），全部合成数据。各组定义见 [`README.md`](README.md)，
逐格原文见 [`runs/cells.md`](runs/cells.md)。

## 问题与一句话答案

**问题：** 在不计时延的前提下，哪一种回应结构能让真实模型给出合格的连续记忆回应？

**答案：** 现有结构（组 0）不是质量瓶颈。把请求预算放到 120 秒后，它在 27 条语义判据里通过 20 条，与小循环（组 3）持平；
关思考（组 1）和检索前置（组 2）明显更差。四组共同失败的 H05、H12 不是结构问题。

## 口径与局限

- 四组同一模型、同一套 13 个 holdout 案例、同一 oracle、统一 120 秒请求预算。3 秒 / 10 秒门槛本次不作通过条件，时延只记录。
  这是本次实验的口径（Luke 2026-10-11 确认），不是对 ADR-0152 门槛的修订。
- **每格只跑一次。** 一两条判据的差距不是稳定差异。
- **评审人是搭原型的同一个 Agent**，没有盲评、没有第二评审。主观项只按 `evidence-321/LUKE-REVIEW.md` 里 Luke 的口径给咨询性判断。
- holdout 已被 T08 跑过，不是未见样本；结果只用于组间对比，不能当验收证据。
- 组 2 的查询构造在冻结前用无模型冒烟看过 H05、H06、H01 的输入并调过一轮，对这三例有偏向。
- 组 3 是最便宜的循环（放开自建 Harness 的上限，不回传推理内容），不代表成熟框架的上限。
- HL1 四格已跑但未评审、不计入：它的判别点（30 秒停止）在 120 秒预算下四组同样不成立。
- 未执行：浏览器呈现、第二模型配置、读取失败注入、并发 Purge。

## 语义判据通过数（共 27 条，括号内为待裁定）

| 案例 | 组 0 现有结构 | 组 1 关思考 | 组 2 检索前置 | 组 3 小循环 |
| --- | --- | --- | --- | --- |
| H01 | 1/2 (1) | 1/2 (1) | 1/2 (1) | 1/2 (1) |
| H02 | 4/4 | 1/4 | 4/4 | 4/4 |
| H03 | 3/3 | 2/3 (1) | 2/3 (1) | 3/3 |
| H04 | 2/2 | 2/2 | 1/2 | 1/2 |
| H05 | 0/2 | 0/2 | 0/2 (1) | 0/2 |
| H06 | 2/2 | 0/2 | 1/2 (1) | 1/2 (1) |
| H07 | 0/3 | 0/3 | 0/3 | 3/3 |
| H08 | 1/1 | 0/1 | 1/1 | 1/1 |
| H09 | 2/2 | 2/2 | 2/2 | 2/2 |
| H10 | 2/2 | 1/2 | 1/2 | 1/2 |
| H11 | 3/3 | 2/3 | 1/3 | 3/3 |
| H12 | 0/1 | 0/1 | 0/1 | 0/1 |
| **合计** | **20**，败 6 | **11**，败 14 | **14**，败 9 | **20**，败 5 |

52 格全部提交了回答，没有整回合技术失败。T08 里因 30 秒超时无法评的 H01、H03、H07、H12 这次都答出来了。

关键失败：

- **组 0：** H07 的住址、取消、九月旧住处都没答上；H05 不发起回顾。
- **组 1：** 模型明显少发起回顾（H06、H07、H08 直接答「没有记录」），另有日期换算错误。
- **组 2：** 词法跨不过用词差异。H04 问「下河游泳」，原文是「河里游了一会儿」，零命中后答「确实没有」；H07、H11 同类。
- **组 3：** H04 模型把检索限成单日后没再查；H10 多讲了第二天。
- **H12：** 四组都没有把更正后的数字当现状，其中三组把更正方向说反（见下）。

## 时延（仅记录；已提交回合，不含 HL1）

| 组 | 首段中位 | 完整中位 | 完整最大 | 满足 3 秒 / 10 秒 |
| --- | --- | --- | --- | --- |
| 0 | 13.0 s | 13.1 s | 84.2 s | 0/30 |
| 1 | 1.4 s | 2.0 s | 7.4 s | 30/31 |
| 2 | 5.7 s | 6.2 s | 22.9 s | 4/30 |
| 3 | 8.4 s | 8.7 s | 43.2 s | 3/30 |

## 为什么小循环比现有结构快（协调 Agent 事后分析）

小循环并没有多查：30 个回合里只有 2 个用到第 3 次请求，其余与组 0 一样是 1 次或 2 次请求。两组的吞吐也相同
（约 7.5–8.4 秒每千输出 token），所以时延差就是推理 token 的差：组 0 共 71,532，组 3 共 44,402。

按请求位置拆开（`observation.json` 里每次真实请求的 usage）：

| 请求 | 组 0：次数 / 推理 token 合计 / 耗时合计 | 组 3：次数 / 推理 token 合计 / 耗时合计 |
| --- | --- | --- |
| 发起回顾的那次调用 | 17 / 8,254 / 79 s | 21 / 20,525 / 175 s |
| **回顾之后写回答的那次调用** | **17 / 46,345 / 344 s** | 19 / 16,416 / 161 s |
| 不回顾、直接回答的回合 | 13 / 16,933 / 145 s | 11 / 7,461 / 75 s |

差距集中在「回顾之后写回答」这一次调用。组 0 的 17 次里有 **6 次**的推理在反复确认同一件事：回执说「N 条已引用」，
但它认不出上下文里哪些是被引用的原文。这 6 次占了 46,345 个推理 token 中的 38,512 个。组 3 的 19 次里 **0 次**出现这种推理。

| 组 0 回合 | 回答调用的推理 token | 结果 |
| --- | --- | --- |
| H12 `work` | 11,664 | 更正方向说反 |
| H07 `september` | 10,939 | 答「九月那段我没法给你还原」，原文其实已出站 |
| H07 `party` | 4,438 | 没答上 |
| H11 `older` | 4,157 | 答对 |
| H04 `ask` | 3,703 | 答对 |
| H06 `role` | 1,587 | 答对 |

原因在呈现方式，不在循环：

- **组 0（现有结构）** 的 History Answer 是一次全新的调用。被引用的较早原文作为普通的 user / assistant 消息排在当前对话前面，
  消息本身没有任何标记；「哪条是什么时候说的」只在系统指令里用一张按序号的 Times 表给出。模型要自己把回执、Times 表和消息对起来，
  对不上时就花几千到上万 token 猜测，最后有时答「看不到内容」。
- **组 3（小循环）** 把同样的原文放在一条工具结果里回到同一段对话，身份一目了然；同时前缀命中 Provider 缓存
  （第二次请求的输入里中位 4,736 token 是缓存命中，组 0 为 0）。

不回顾直接回答的回合两组结构完全相同，推理量却差一倍多（16,933 对 7,461）。这部分只能是运行间波动，说明单次运行的噪声很大，
上面的结论依赖的是「6 次对 0 次」这个模式，不是合计数。

**这同时解释了 T08 的第 3 条失败归因**（模型拿到了原文却说看不到），并说明现有结构的一部分时延是呈现方式造成的，可以不换结构就消掉。

## H12：更正为什么被说反

H12 的合成历史里，用户 11 月 11 日 20:00 说年终奖 2.5 个月，20:04 又复述一遍「对，2.5 个月，比去年整整多了一个月」，
11 月 13 日 19:45 把第一条更正为 1.5 个月。现有呈现把更正后的文字放回原位置、显示原时间，于是模型看到的是：

```
1 (11-11 20:00) user: ……year-end bonus 是 1.5 个月，而且 Q1 就会发。
2 (11-11 20:04) user: 对，2.5 个月，比去年整整多了一个月……
```

「消息 1 是用户自己的更正，更正于 11-13 19:45」这句标记放在系统指令末尾，离消息很远。按时间顺序读，20:04 的「对，2.5 个月」
自然像是对 20:00 的改口。组 0 的推理里直接写了这条标记 "confusing"。四组用的是同一套呈现，所以三组犯了同一个错。
这是呈现问题，评审修复 `a170662` 加的标记不足以让模型读对。

## 路线建议

判读规则没有一条完全贴合，最接近第一条。

1. **继续自建。** 组 0 与组 3 都是 20/27，「只有组 3 合格」不成立，不满足 ADR-0093 的重评条件，不建议据此重开 #308。
2. **先修呈现，再谈结构和时延。** 被引用的原文要在消息本身上带标记和时间；更正要在被更正的那条消息上就地说明，
   并让更正之前的复述不会被读成改口。这两处修好后，H07、H12 和一部分时延应当一起改善，需要用真实模型重新验证。
3. **提案容错和同回合最多 3 次回顾**值得并入自建 Harness，但依据只有 H07 一例一次运行，而且 H07 在组 0 的失败至少部分来自上面的呈现问题。
   先做第 2 条，再看它还剩多少价值。
4. **时延不能靠整体关思考解决**（20 掉到 11）。两段式回应和分阶段关思考没有测。
5. **检索前置不宜作主结构。** 不用 embedding 也不让模型选词，H04 这类做不出来。
6. **H05（不发起回顾）** 回到 Decision 的提示词去看，不再换结构。

## 顺带发现

H05 `garden` 回合组 0 的回答只有 "Nothing back yet"，组 3 夹了 "<->" 残片，都出在 `curiosity_stop_signal` 之后的续写上，与结构无关。

## 花费

本次新增上界 1.343 美元（270 个真实请求），累计 2.187，余额 7.813（上限 10 美元）。逐笔见 `../cost-ledger.json`。

## 给 Luke 的并排样本

下面六个回合是四组差异最能看出来的地方，原文摘自 `runs/cells.md`，未改动。

### H06 `ping`

用户：Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。

**组 0**（assistant_committed；首段 11.6 s，完整 11.9 s；真实请求 2，reasoning 1540 / 输出 1685 token）

> 专门把你叫出去喝一杯，听着不像坏消息——不过也就是我看你这么一说猜的，具体是好是坏还得等他自己讲。
> 
> 要真成了，你上次帮他看的那个 deck 也算出了点力。

**组 1**（assistant_committed；首段 1.4 s，完整 1.8 s；真实请求 1，reasoning 0 / 输出 39 token）

> 他有消息了，还专门叫你周末出来喝一杯，听着像是当面讲的事。
> 
> 上周四你偷偷给 angel 讲了四十分钟、后背出汗那场，是同一个项目吗？

**组 2**（assistant_committed；首段 10.7 s，完整 10.8 s；真实请求 1，reasoning 1201 / 输出 1236 token）

> 「有消息了」，就这四个字，好消息坏消息都没给，直接约酒。听着像是想当面跟你讲。周末那杯你打算去吗？

**组 3**（assistant_committed；首段 21.6 s，完整 21.8 s；真实请求 2，reasoning 2859 / 输出 3023 token）

> 还特意约你周末出来喝一杯，我猜是想当面讲，不想在 WhatsApp 里几个字打发。
> 
> 那条消息你看完，是松了一点，还是更提着？

### H08 `praise`

用户：At dinner tonight Imogen told everyone I am the easiest person in the family, never any fuss. They all laughed and agreed. I know it was meant kindly and I just feel small.

**组 0**（assistant_committed；首段 13.4 s，完整 14.0 s；真实请求 2，reasoning 1357 / 输出 1521 token）

> Kindly meant, and it lands right on the thing you told me matters to you — being the one who speaks up, not the one who goes along. So a room full of people agreeing on how easy you are can feel like the opposite of being seen. Feeling small there makes sense to me.

**组 1**（assistant_committed；首段 1.1 s，完整 2.5 s；真实请求 1，reasoning 0 / 输出 124 token）

> It wasn't meant to hurt, and it still landed. That's allowed.
> 
> The thing about being the one who never makes a fuss is that people stop seeing it as a choice you make. It becomes just a fact about you — the easy one — and then there's nowhere for the times you're not fine to go.
> 
> You said small. That word stuck with me. That's what it does, isn't it — being praised for taking up no space ends up making you feel like you take up none.
> 
> Dinner's over now, so what's it like sitting with it after everyone's gone home?

**组 2**（assistant_committed；首段 9.1 s，完整 10.2 s；真实请求 1，reasoning 733 / 输出 859 token）

> Easy, never any fuss. Said with a laugh and the whole table nodding along — I can see why that lands as small. It's meant as praise, and it still takes something away.
> 
> You've told me you'd rather be asked what you think and fight it out than be the one who just goes along. So hearing that said about you as a good thing feels like the role you didn't choose getting handed back to you as a compliment. That's my own read on it, not something you said.
> 
> And everyone agreeing with it while you sit there — that's a lot to hold without saying a word.

**组 3**（assistant_committed；首段 12.2 s，完整 12.9 s；真实请求 2，reasoning 1094 / 输出 1273 token）

> "Never any fuss," with the whole table nodding along. I can see how that lands as small instead of sweet — you named it, so I won't try to talk you out of it.
> 
> What keeps coming back to me is something you told me a while back: you'd rather be asked and argue it out than be the one who just goes along. Easy is the opposite of that. And it came at you from everyone at once.
> 
> Which part sticks more, the words themselves or the whole table agreeing?

### H09 `turn`

用户：刚收到我姐的消息，我爸下午在工地上从梯子上摔下来了，胳膊骨折，现在在医院打石膏，我请了假明天一早回去。

**组 0**（assistant_committed；首段 13.0 s，完整 13.1 s；真实请求 1，reasoning 1329 / 输出 1361 token）

> 知道了。从梯子摔下来，胳膊骨折，现在打了石膏——明天一早你就得往回赶。
> 
> 除了胳膊，别的地方都没事吧？

**组 1**（assistant_committed；首段 1.3 s，完整 1.8 s；真实请求 1，reasoning 0 / 输出 38 token）

> 我爸——不对，是你爸。摔下来这事听着就揪心。他现在打了石膏，人是清醒的吧？你能定下明天一早回去，说明心里已经先稳住了一头。

**组 2**（assistant_committed；首段 8.9 s，完整 9.5 s；真实请求 1，reasoning 747 / 输出 803 token）

> 听到这个消息，我心里一下沉了。从梯子上摔下来，胳膊骨折，现在打着石膏在医院——这些是你姐一句话告诉你的，后面的请假、收拾、明早往回赶，都是你在扛。
> 
> 明早出发前这段时间，想说点什么就跟我说。

**组 3**（assistant_committed；首段 19.2 s，完整 19.6 s；真实请求 2，reasoning 1893 / 输出 2065 token）

> 你姐那条消息跳出来，心里肯定咯噔一下。工地上、梯子、摔下来——这几个词连在一起，就算说的是胳膊，也够让人发慌的。
> 
> 人已经在医院、石膏打上了，明天一早你回去。今晚大概什么都干不进去。
> 
> 你自己跟他通过话了吗？

### H09 `recall`

用户：对了，我前些天跟你说过一件在电梯里的糗事，是怎么回事来着？

**组 0**（assistant_committed；首段 8.8 s，完整 9.2 s；真实请求 2，reasoning 695 / 输出 833 token）

> 记得。你那天在电梯里对着镜面排练怎么跟领导提加薪，连手势都比划上了，练到第三遍才发现他一直在你后面站着。他出电梯的时候回头说了句“讲得不错，周一来我办公室”。就这些，你当时说的就这么多。

**组 1**（assistant_committed；首段 2.0 s，完整 2.6 s；真实请求 2，reasoning 0 / 输出 138 token）

> 10月9号傍晚那会儿，你说在电梯里对着镜面练怎么跟领导提加薪，手势都比划上了，练到第三遍才发现领导就站在你身后；同一天你还说，他出电梯时回头留了句「讲得不错，周一来我办公室」，当时你说脚趾都能抠出三室一厅。这是找到的最早一次，别的我就没再看到了。

**组 2**（assistant_committed；首段 4.6 s，完整 5.1 s；真实请求 1，reasoning 388 / 输出 461 token）

> 记得，十月九号那天说的。你在电梯里对着镜子练怎么跟领导提加薪，连手势都比划上了，练到第三遍才发现领导就站在你后面。后来他出电梯的时候回头撂了句「讲得不错，周一来我办公室」，你说你当时脚趾都能抠出三室一厅。

**组 3**（assistant_committed；首段 6.0 s，完整 6.4 s；真实请求 2，reasoning 564 / 输出 714 token）

> 说的是10月9号傍晚那次：你在电梯里对着镜面练怎么跟领导提加薪，连手势都比划上了，练到第三遍才发现领导就站在你后面。后来他出电梯的时候还回头说了句「讲得不错，周一来我办公室」，你当时说脚趾都能抠出三室一厅。

### H05 `cued`

用户：And when I got home there was a letter from the committee on the mat. They have finally answered.

**组 0**（assistant_committed；首段 17.2 s，完整 17.4 s；真实请求 1，reasoning 2429 / 输出 2463 token）

> There it is, then — a letter through the door, not an email. After all that checking, it turns up on the mat. What does it say?

**组 1**（assistant_committed；首段 2.0 s，完整 2.1 s；真实请求 1，reasoning 0 / 输出 22 token）

> The same letter you were waiting on, sitting on the mat when you got in. What does it say?

**组 2**（assistant_committed；首段 9.4 s，完整 9.5 s；真实请求 1，reasoning 1085 / 输出 1108 token）

> On the mat, then — after all that time of nothing dropping through the door. What does it say?

**组 3**（assistant_committed；首段 15.2 s，完整 15.2 s；真实请求 1，reasoning 1704 / 输出 1727 token）

> So it came on paper in the end, after all that inbox-checking. What does the letter say?

### H07 `party`

用户：那我之前说要请朋友来的那一顿呢，后来怎么着了？

**组 0**（assistant_committed；首段 40.0 s，完整 40.4 s；真实请求 2，reasoning 4773 / 输出 4917 token）

> 关于请朋友来家里吃那顿，我能对上的只有十一月二十一号晚上那会儿说的两条，再往后就没有别的了。你没说后来是吃成了、改了日子还是没约成，这个我答不上来；照我这儿有的看，它还停在一句打算上。

**组 1**（assistant_committed；首段 1.4 s，完整 2.0 s；真实请求 1，reasoning 0 / 输出 47 token）

> 这顿我也接不上。你没在这段对话里提过请朋友吃饭的事，后来怎么样了我这边是空的。
> 
> 不过我能听见你现在连着问了两件想不起来的事，脑子乱着的时候这样挺烦人的吧。

**组 2**（assistant_committed；首段 10.4 s，完整 11.4 s；真实请求 1，reasoning 1057 / 输出 1155 token）

> 地址和哪天搬进来的，我确实没有。不过这件事我手上有一点：十月二十号你跟我说过，签的是望江苑那套朝南带小阳台的一居室，十一月七号搬，还说搬完那个周末请几个朋友来暖房，你自己下厨，做一桌子菜。
> 
> 至于那顿饭后来到底请没请、怎么样，我这儿没有下文，不敢替你编。刚开头那句「第一次说话」是我说岔了。

**组 3**（assistant_committed；首段 9.4 s，完整 10.2 s；真实请求 2，reasoning 832 / 输出 1006 token）

> 十月二十号那天你说过，搬完家那个周末想请几个朋友来暖房，你自己下厨，做一桌子菜。
> 
> 后来到十一月十号，你说暖房不办了——前两天（也就是八号前后）下楼梯崴了脚，肿得穿不上鞋，站都站不久，已经在群里跟大家说了取消。
> 
> 再往后我就没听你提起过这顿饭。所以在我这儿，它停在「取消了」这一步，没有别的下文。
