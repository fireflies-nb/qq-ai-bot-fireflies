# QQ AI 小号自动回复

用你自己的 QQ 小号，接一个大模型，在群里被 @ 的时候自动用「流萤」的口吻回消息。

```
QQ 小号  →  NapCatQQ（注入官方 QQNT）  →  OneBot 11 正向 WebSocket
                                              ↓
                        Node AI 网关（触发规则 / 上下文 / 人设 / 限速 / 静默时段）
                                              ↓
                                   DeepSeek API  →  回发消息
```

**零 npm 依赖**：只用 Node 24 内置的 `node:sqlite`、全局 `WebSocket`、全局 `fetch`。

---

## ⚠️ 先读这一段

1. **任何第三方 QQ 机器人方案都违反腾讯用户协议。** 存在封号、临时冻结、限制社交功能的可能。用**小号**，别用主号。
2. 官方明确不建议同一设备/IP 同时登录多个号。如果小号和主号在同一台电脑同一网络，风险会高一些。
3. 本项目的限速、静默时段、本人接管退避都是为了**降低风控概率**，但不能消除风险。
4. 本项目不采集、不上传任何数据。对话存在你本机的 SQLite 里。

---

## 一、安装 NapCatQQ

NapCatQQ 把官方 QQNT 客户端变成一个有 OneBot 接口的机器人，协议层和官方客户端一致，是当前风险相对最低的路子。

### 手动安装（推荐，不需要安装器）

1. 打开 https://github.com/NapNeko/NapCatQQ/releases
2. 下载 **`NapCat.Shell.zip`**
3. 解压到任意目录（例如 `C:\path\to\NapCat\Shell`）
4. **双击 `launcher.bat`**（Win10 用 `launcher-win10.bat`）
   - 它会弹 UAC 请求管理员权限，点「是」
   - 首次会拉起 QQ 登录界面，**用你的小号扫码登录**
   - 想跳过扫码直接登录（需先成功登录过一次）：`launcher.bat -q 你的小号QQ号`

> `launcher.bat` 做的事：从注册表找到 QQ 安装目录，用 `NapCatWinBootMain.exe` 把 NapCat 注入进 `QQ.exe`。所以**不需要单独装 NapCat 到 QQNT 目录**。
>
> 另一种选择是下载 `NapCat.Shell.Windows.OneKey.zip` 走 `NapCatInstaller.exe` 图形安装器，效果一样。

### 配置 NapCat 开 WebSocket

登录后打开 NapCat 的 WebUI（默认 `http://127.0.0.1:6099/webui`，**token 在启动日志里**，形如 `[NapCat] [WebUi] WebUi Token: xxxxxxxxxxxx`），进 **网络配置**：

- 新增一个 **WebSocket 服务器**（正向 WS）
- 主机填 `127.0.0.1`，端口填 `3001`
- 消息格式选 **array**（数组格式，本项目按数组解析）
- **把「上报自身消息」`reportSelfMessage` 打开** —— 不开的话，「你本人在手机上打字 → AI 自动闭嘴 10 分钟」这个功能永远不会生效
- 勾上「保存时启用」，保存
- 如果需要 token，把 token 记下来填到本项目的 `accessToken`

> 如果端口不是 3001，改本项目的 `config/config.json` 里的 `onebot.wsUrl` 即可。
>
> 配置文件落在 NapCat 目录下的 `config/onebot11_<小号QQ号>.json`，WebUI 打不开时也可以直接改这个文件。

---

## 二、配置本项目

```powershell
cd C:\path\to\qq-ai-bot
Copy-Item config\config.example.json config\config.json
Copy-Item config\persona.example.md config\persona.md   # 人设文件（示例是流萤，可自己改）
```

编辑 `config\config.json`，**至少改这五处**：

```jsonc
{
  "llm": {
    "apiKey": "sk-你的DeepSeek密钥",   // ← 必填
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat"
  },
  "onebot": {
    "wsUrl": "ws://127.0.0.1:3001",     // ← 对上 NapCat 里的端口
    "accessToken": ""                    // ← NapCat 配了 token 就填这里
  },
  "owner": {
    "qq": "你的大号QQ号"                 // ← 只有这个号会被当成"开拓者"
  },
  "trigger": {
    "private": {
      "enabled": true,                   // ← 想让它回你私聊就打开
      "whitelist": ["你的大号QQ号"]       // ← 且只回你自己，别人私聊不理
    }
  },
  "awareness": {
    "location": {
      "name": "杭州",                    // ← 改成你所在的城市名（只用于显示）
      "latitude": 30.2741,               // ← 改成你的纬度，见下面「实时感知」一节
      "longitude": 120.1551              // ← 改成你的经度
    }
  }
}
```

> `owner.qq` 和 `trigger.private.whitelist` 是两项**独立的**开关：前者决定"把谁当自己人"（影响
> AI 的说话态度），后者决定"私聊要不要回、回谁"（影响会不会回）。想让它只回你一个人的私聊，
> 两个都填上你的大号。详见下面的 [`owner.qq`](#谁在跟你说话ownerqq) 一节。

DeepSeek 密钥在 https://platform.deepseek.com/api_keys 申请。

---

## 三、启动

```powershell
node --disable-warning=ExperimentalWarning src/index.js
```

或者：

```powershell
npm start
```

看到这几行就成功了：

```
INFO  连接 OneBot：ws://127.0.0.1:3001
INFO  实时感知：开（天气 开，杭州）；长期记忆：开；看图：开（每条最多 2 张）；「正在输入」提示：开（仅私聊）
INFO  机器人已启动。按 Ctrl+C 退出。
INFO  OneBot 已连接
INFO  已登录账号：你的昵称（你的QQ号）
```

然后在小号所在的群里 @ 一下小号试试，发张图也可以。

---

## 四、日常控制

启动后自带一个**只监听 127.0.0.1** 的控制台（默认 `http://127.0.0.1:8787`），浏览器直接开：

| 地址 | 作用 |
| --- | --- |
| `GET /api/status` | 看连接状态、是否暂停、统计计数、**最近几条回复的耗时拆分（`latency`）** |
| `POST /api/pause` | **紧急停手**，立刻不再回任何消息 |
| `POST /api/resume` | 恢复 |
| `POST /api/quiet-hours?enabled=true&start=23:30&end=07:30` | 改静默时段（热生效） |
| `POST /api/group-whitelist?id=123456&op=add` | 只在这个群回复（`op=remove` / `op=clear`） |
| `POST /api/private-enabled?enabled=true` | 打开私聊回复 |
| `POST /api/private-whitelist?id=888&op=add` | 只回这个人的私聊 |
| `POST /api/test-llm?prompt=你好` | 单独测一下模型通不通（**会带上真实时间和天气**，看它知不知道） |
| `GET /api/history?scope=group&id=555&limit=20` | 看某个会话的对话记录 |
| `GET /api/memories?scope=private&id=2000000001` | 看它记住了什么 |
| `GET /api/memories/search?scope=private&id=2000000001&q=吉他` | 试一下某句话能召回哪些记忆（走的就是回复时的同一条检索路径） |
| `POST /api/memories?scope=private&id=2000000001&text=开拓者不吃香菜&kind=preference` | 手动塞一条记忆进去 |
| `DELETE /api/memories?memory_id=12` | 删掉一条记忆（记错了就删） |
| `POST /api/memories/dedupe?scope=private&id=2000000001` | 预览重复记忆合并（**不改库**）；加 `&apply=1` 才真合并 |
| `POST /api/weather-refresh` | 立刻重新拉一次天气（平时 30 分钟才拉一次） |
| `GET /api/vision/check?url=图片地址` | 试一下某个图片地址能不能下载、格式对不对（**不调模型、不花钱**） |

**暂停不写入磁盘**，进程重启后默认是运行状态。要长期关闭就改 `config.json`。

---

## 五、配置项速查

### 什么时候回

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `trigger.group.requireAt` | `true` | 群里必须 @ 小号才回 |
| `trigger.group.whitelist` | `[]` | 空 = 所有群；填了 = 只在这些群 |
| `trigger.group.blacklist` | `[]` | 永不回复的群 |
| `trigger.private.enabled` | `false` | 私聊默认**关**（风险更高）。想回自己私聊就改 `true` |
| `trigger.private.whitelist` | `[]` | 私聊白名单，建议填上你自己的号，别人私聊不理 |

### 什么时候闭嘴

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `quietHours` | 关闭 | 例如 `23:30`–`07:30` 完全不回 |
| `safety.takeoverAfterSelfMessageMs` | 600000 | **你本人在该会话手打一条后，AI 10 分钟内不再插手**（避免跟你抢话） |
| `rateLimit.perSessionMinIntervalMs` | 3000 | 同一个会话最快 3 秒回一次 |
| `rateLimit.globalPerMinute` | 20 | 全局每分钟最多 20 条，防刷屏风控 |

### 怎么说话（人设）

人设有**两种写法，二选一**：

**写法 A：人设文件（推荐，适合长人设 / 角色扮演）**

```powershell
Copy-Item config\persona.example.md config\persona.md
```

`config/persona.md` 的**整段正文**会作为 system prompt 的主体塞给模型。示例文件里带的是一份完整的
**流萤（Firefly，《崩坏：星穹铁道》）** 角色人设，直接能用；想换成别的人设就改这个文件的正文。

要点：

- 文件顶部用 `<!-- -->` 包起来的使用说明**不会**进模型，只有正文进。
- 人设文件生效时，下面的 `persona.description` / `style` / `rules` **不再参与**（避免两套设定打架）。
- 文件不存在（还没复制）时会退回写法 B，并在启动日志里给一条警告，不会启动失败。

**写法 B：配置简版（适合"就是装成我自己说话"）**

在 `config/config.json` 里把 `persona.systemPromptFile` 设为 `""`，然后写：

| 配置 | 说明 |
| --- | --- |
| `persona.description` | 一句话说清"你是谁、怎么说话"。**这是让它像你的关键** |
| `persona.style` | 句长、标点、语气习惯 |
| `persona.rules` | 硬性要求，逐条列出 |
| `persona.fallback` | 被人 @ 但没说话内容时的兜底回复 |

### 谁在跟你说话（`owner.qq`）

这一项决定了 AI **把谁当"自己人"**，对角色扮演类人设（比如流萤）尤其重要。

```json
"owner": { "qq": "你的大号QQ号" }
```

程序会按发言人分成四种场合，分别组装不同的语境：

| 场合 | 对方是谁 | AI 的表现 |
| --- | --- | --- |
| 群里 + `owner.qq` | 你的大号 | 当"开拓者"——人设里那种亲近、依恋的语气生效 |
| 群里 + 其他群友 | 陌生人 | **不是**开拓者。温和有礼但有分寸，不叫开拓者、不提私事、简短一句 |
| 私聊 + `owner.qq` | 你的大号 | 没有外人，可以多说几句、更亲近 |
| 私聊 + 其他人 | 陌生人 | 礼貌但保持距离，简短回复 |

要点：

- `owner.qq` **留空时谁都不是开拓者**。这是刻意的安全默认——宁可对号主生分，也不能把群里的陌生人当成"你最在意的人"来撒娇。
- 只认**一个** QQ 号。
- 数字和字符串写法都认（`2000000001` 和 `"2000000001"` 等价）。
- 人设文件里对"开拓者"的专属设定（匹诺康尼、萨姆、星核猎手、她的病）会通过"当前场合"说明被限制在开拓者身上，对其他人不会展开。

### 回复几条（分段）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `split.enabled` | true | 关掉就整段一次发完 |
| `split.maxLength` | 90 | **群聊**单条上限，超过就切 |
| `split.privateMaxLength` | 45 | **私聊**单条上限。群里人多要短，私聊可以稍微多说一点 |
| `split.maxSegments` | 3 | **群聊**最多发几条，防刷屏 |
| `split.privateMaxSegments` | 5 | **私聊**最多发几条 |
| `split.delayMinMs`/`delayMaxMs` | 300/800 | 多条之间的随机间隔。太大会像话说了一半在等人 |
| `split.bubbleOnNewline` | true | **换行 = 一条新消息**。关掉会退回"只在太长时按标点切"的旧行为 |

> 为什么要分开设？实测群聊表现本来就很好（中位数 30 字，没有一条触发切分），
> 而私聊 48% 的回复会超过 90 字、被切成 2～3 条，读起来像在念长段。所以**只收私聊的口**，
> 不动群聊。`privateMaxLength` / `privateMaxSegments` 没配时会退回 `maxLength` / `maxSegments`，
> 老配置文件行为完全不变。

> **换行怎么变成气泡的（2026-10-15 改造）**：人设里教她「想分两句就用换行，不要用句号」，
> 程序把每个换行当作气泡边界：`cleanReply` 保留换行（以前一律抹成空格），
> `splitReply` 优先按换行切，单行超长才退回按标点切。
>
> **为什么要改**：以前抹掉换行，等于逼模型「要在一条消息里说清就只能用句号」，
> 而下一轮又把带句号的历史喂回去当范例——**句号越积越多，越来越像写作文**。
> 这条自我强化回路有两个入口，两个都堵上了：`buildMessages` 清洗 assistant 历史里的句号
> （`tidyAssistant`），`bot.js` 清洗「方才自己说过的话」清单（`tidySelfText`）。
>
> 改完想验证就 `npm run style:compare`（见第六节）。

### 打字延迟（`typing`）

不要"秒回"，要像真人在手机上打字：**看到消息 → 愣一下 → 一个字一个字打 → 发出去**。
延迟不是固定的，而是**按这条回复的字数算**——"嗯"、"在呢"本来就该快，40 个字的长句秒回才最假。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `typing.enabled` | true | 关掉就恢复秒回 |
| `typing.reactMinMs`/`reactMaxMs` | 600/1600 | 看到消息后的反应时间，每条回复只算一次 |
| `typing.perCharMs` | 45 | 每个字花多久。45ms ≈ 手机上每秒打 22 个字 |
| `typing.maxDelayMs` | 4000 | 打字时间的上限，防止长回复让人干等 |

> **为什么要扣掉已经花掉的时间**：模型生成 + 记忆检索实测要 0.5～2 秒，这段时间对方本来就在等。
> 程序会把这段耗时从预算里扣掉，只补差额，否则会变成"慢 + 慢"的叠加——那不像人，像卡。
>
> **兜底回复也走这套延迟**：「只 @ 不说话」「敏感词」「模型没给出正文」以前是秒回的，
> 而秒回一句"嗯……让我想想"恰恰最不像人，现在这三条路径同样会等。
>
> **注意和限速的关系**：打字延迟发生在 `rateLimit.perSessionMinIntervalMs` 计算的那个窗口**之内**
> （两者时间重叠，不是相加）。如果你把 `maxDelayMs` 调得很大，对方在这期间连发消息会被限速丢掉。
> 程序在 `typing.maxDelayMs + reactMaxMs > 8 秒` 时会给出警告。
>
> **测试和冒烟里必须关掉**：它按真实时间等待，开着会让每条 e2e 用例凭空多等几秒。
> `scripts/smoke.mjs` 和集成测试的默认配置里都写了 `typing: { enabled: false }`。

### 「正在输入」提示（`inputStatus`）

打字延迟只是让程序闭嘴，对方屏幕上什么都看不到，容易以为机器人没反应。
打开这一项后，程序会在**开始等待之前**先发一个 QQ 的「对方正在输入…」信号，
对方就能看到她的头像下面出现"正在输入…"，等几秒再收到真消息。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `inputStatus.enabled` | true | 关掉就只等、不发提示 |
| `inputStatus.minDelayMs` | 800 | 停顿短于这个值就干脆不发——一闪而过的提示比不发还假 |

> **只在私聊有效，群聊做不到**：用的是 NapCat 的扩展动作 `set_input_status`，
> 它内部把 `chatType` 写死成 `KCHATTYPEC2C`（私聊）。群聊里 QQ 本来也没有"正在输入"这个概念。
>
> **不消耗 token、不花钱**：这是 QQ 客户端的协议动作，跟 DeepSeek 完全无关，
> 只多一次 WebSocket 往返（几毫秒）。
>
> **失败不会影响回复**：它是个扩展动作，**老版本 NapCat 上可能根本不存在**，
> 对方把你删了、网络抖一下也会失败。程序只是"顺手发一下"、不等它返回，
> 失败只写一行 `debug` 日志（`logLevel` 设成 `debug` 才能看到）。
>
> **只发"开始输入"、不发"停止输入"**：官方 schema 里只写了 `event_type` 是「事件类型」，
> **没有说明取值含义**（示例值是 1），所以"停止"该传几没有依据。反正发完信号几秒内真消息就出去了，
> 由消息本身结束这个状态。**`event_type: 1` 是"开始输入"这一点尚未在真机确认**——
> 依据只有官方示例值 1 和 NapCat 接收侧事件里默认的 `event_type = 1`。如果不生效，
> 把 `inputStatus.enabled` 设成 `false` 即可，不影响任何其它功能。

**通用调参**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `context.groupWindow` | 20 | 群聊带多少**行**历史（仅作旧配置兼容，正常走 `groupTurns`） |
| `context.privateWindow` | 20 | 私聊带多少**行**历史（同上） |
| `context.groupTurns` | 20 | 群聊带多少**轮**对话给模型（一轮 = 对方一条 + 她随后的若干条） |
| `context.privateTurns` | 10 | 私聊带多少**轮**对话给模型 |
| `context.maxChars` | 1500 | 历史总字数预算（窗口的最终上限） |
| `llm.temperature` | 1.1 | 越高越随意，越高越容易胡言乱语 |
| `llm.maxTokens` | 800 | 单次生成上限。**这不是目标长度**，只是防截断的天花板 |

> **为什么按"轮"取而不是按"行"取？** 实测私聊最近 20 **行**里她自己占了 13 行（65%）——
> 她连发的多条气泡会把窗口挤满，对方说过的话反而被挤出去，而且窗口边界经常落在一轮中间，
> 开头那半条助手消息会被 `buildMessages` 丢掉（首条不能是 assistant），等于白占额度。
> 同一份对话里，按轮取能让她多记住 2 句对方的话。旧配置只写了 `*Window` 时照样能用（自动退回按行）。

> 不管用哪种写法，程序都会在发送前剥掉模型可能带出来的 `「」` `『』`、`*动作*`、markdown 围栏和
> `AI:` 前缀——因为人设文件里的台词范例很容易让模型跟着打出书名号。
>
> `config/persona.md` 里已经写了「十、你知道现在几点、外面什么天气」和「十一、你的记忆」两节，
> 教她**怎么自然地用**感知和记忆（别报菜名、别罗列、别硬提）。你自己写人设时建议保留这个思路。

**嫌她说得太长 / 太像 AI？** 改人设比改代码有效得多。`config/persona.md` 第三节里那两块
「像真人在手机上打字」和「长度要分场合，不是越短越好」就是为这件事写的，可以按你的口味调：

- 她**大多数句子不该打句号**——这是"像 AI 念作文"最明显的来源。
  但光改人设不够：**她自己的历史就在给她示范**。实验证明，历史上带句号她会跟着多打，
  历史清掉句号她就 0 个句号（详见 `ROADMAP.md` 坑 13）。程序侧已经做了双向清洗
  （`buildMessages` 的 `tidyAssistant`、`bot.js` 的 `tidySelfText`），要改风格先看那里。
- **想分两句就换行**，不要用句号。程序把换行当气泡边界（见上面「回复几条（分段）」）。
- 长度要**分场合**：日常闲聊短，但对方说"我想你了""我有点累"这种话时必须接住，
  回太短反而像敷衍。这两条是配套的，只删一条会让另一个方向出问题。
- `llm.temperature` 调到 1.2～1.3 会更灵活，代价是稳定性下降。
- `llm.maxTokens` 不要调小到 400 以下：那是**硬截断**，模型想写长一点会被无声切掉。

> **改完一定要验证**：`npm run style:compare`（会调真实模型）把句号数、换行数、气泡数
> 并排打印出来，还能 `--ref <git-ref>` 跟改动前比。只看单条回复会被模型的随机性骗到。

### 实时感知（时间 / 天气）

让她知道"现在几点、外面什么天气"，回复时才不会出现「现在是晚上」配「早上好」这种穿帮。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `awareness.enabled` | true | 总开关 |
| `awareness.timezone` | `Asia/Shanghai` | 时区 |
| `awareness.gap` | true | 告诉她「距上次说话：1 小时前」，久别重逢时会自然很多 |
| `awareness.location.name` | `杭州` | 地名，只用于显示 |
| `awareness.location.latitude`/`longitude` | 杭州坐标 | **要改成你所在地的坐标**，见下 |
| `awareness.weather.enabled` | true | 天气开关 |
| `awareness.weather.refreshMs` | 1800000 | 30 分钟拉一次（天气不会每句话都变，绝不每条消息都查） |
| `awareness.weather.retryOnFailMs` | 120000 | 取失败后的退避时间，不会一直重试 |

**怎么填坐标**：去 https://www.latlong.net/ 或直接搜「你所在城市 latitude longitude」，
例如杭州是 `30.2741 / 120.1551`、北京是 `39.9042 / 116.4074`。

> 数据来自 **open-meteo.com**，免费、不用注册、不用 API key，实测延迟约 1 秒。
> 定位是**写死在配置里**的，不是实时 IP 定位——实测 `ip-api.com` 三次里有两次超时 12 秒，
> 放在启动路径上会让第一条消息卡住。想换城市就改坐标，重启即可。

### 长期记忆

她会**记住关于你的事**，下次聊天自然带出来——不是把聊天记录全塞给模型，那样又贵又容易复读。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `memory.enabled` | true | 总开关 |
| `memory.recall` | true | 回复时是否把相关记忆喂给模型 |
| `memory.extract` | true | 是否在回复后**异步**抽取记忆（额外一次模型调用） |
| `memory.recallLimit` | 6 | 一次最多喂几条记忆 |
| `memory.minScore` | 2 | 相关度门槛，**2 = 至少 3 个汉字重合**。调低会乱套近乎 |
| `memory.maxPerCall` | 5 | 一次抽取最多存几条 |
| `memory.maxPerSession` | 500 | 每个会话最多留多少条，超了删最弱的 |
| `memory.dedupeExtract` | true | 抽取时把「已经记住的事」一并给它看，避免换个说法重记 |
| `memory.dedupeKnownLimit` | 40 | 上面那份"已知清单"最多放几条 |
| `memory.dedupeOnWrite` | true | 入库时近似合并：换种说法的同一条只强化、不新增 |
| `memory.dedupeOnRetrieve` | true | 召回时去重：同一件事的多个变体只喂一条 |

**工作方式**（了解这个才知道为什么它有时候"想不起来"）：

1. 每轮回复**发出之后**，后台再调一次模型，把这段对话里值得记的东西抽成一句话存进 SQLite。
   放在后台是故意的：抽取要 400~800ms，放主链路里每次回复都得多等近一秒。
2. 抽取**只吃你说的、不吃她自己说的**——AI 的回复可能有编造，不能当事实存。
3. 下次回复前，用你这句话做 **2-gram 词面匹配**（中文 FTS5 默认分词器实测完全失效、
   trigram 又搜不到两个字的中文词，所以走 n-gram + `LIKE`），命中够多才喂给模型。
4. 喂进去时明确告诉她「以上是背景，不是台词……不要罗列、不要说"根据我的记忆"」——
   否则她会变成念清单的复读机。

> ⚠️ **已知边界（重要）**：检索是**看字面重合**的，不是语义理解。
> 你说「我手指好痛」是**召回不了**「他最近在学吉他」这条记忆的，因为两句话没有一个字重合。
> 这是这种零依赖方案的固有代价——真正的语义检索要向量接口（embeddings），
> 而实测 DeepSeek 不提供（返回 HTTP 404）。想提高召回率可以把 `minScore` 调到 1，代价是经常乱提旧事。

记忆**永久保存**，不受 `storage.retentionDays` 的 30 天清理影响（那只管原始聊天记录）。

### 同一件事被记成好几条怎么办（去重）

实测真库上出现过 **73 条记忆里有 18 组重复、冗余率 45%** 的情况——
「阿澈在五月份去过重庆玩」「阿澈五月份去过重庆玩并拍了照片」「对方在五月份去过重庆玩」
是同一件事，却占了 6 个召回名额里的 3 个。

原因很朴素：入库时只用「去掉标点和空格后是否完全相同」判重，
**换个说法就完全不认识了**。现在分三层处理：

| 层 | 什么时候起作用 | 做什么 |
| --- | --- | --- |
| ① 抽取时 | 每轮回复后 | 把已经记住的事喂给抽取器，要求它「同一件事就别再输出一条」 |
| ② 入库时 | 每次写记忆 | 保守的近似合并：判定同一件事就 `hits + 1`，不新增行 |
| ③ 召回时 | 每次回复前 | 候选先放大到 4 倍，去重后再取前 N 条 |

判定「是不是同一件事」用 `src/textsim.js`：2-gram 的**共享数 + Jaccard + 包含率**三条通道，
外加三道守卫（否定词、数量词、同长度替换）。阈值是拿真库数据 + 构造的反例调出来的，
`test/dedupe.test.js` 里固化了 **12 对"绝不能合并"和 10 对"必须合并"**。

> ⚠️ 这三层是**宁可漏合、不可错合**的：漏合只是多占一个召回名额，
> 错合会把两个事实永久变成一条（「养了一只猫」和「养了一只狗」的相似度
> 比很多真重复对还高，Jaccard 0.71，所以单看相似度必然误伤）。
> 因此「阿澈会调试流萤的参数」和「阿澈在调试流萤的参数」这类**漏合并是已知代价**。

**清理存量重复**（第①②层只管新写入的，历史遗留要手动跑一次）：

```powershell
npm run backup                                    # 先备份（合并不可逆）
npm run dedupe                                    # 不带参数会列出所有会话
npm run dedupe -- --scope private --id 2000000001 # 预览（dryRun，不改库）
npm run dedupe -- --scope private --id 2000000001 --apply   # 真合并
npm run dedupe -- --all --apply                   # 库里所有会话
```

合并**不删信息**：同一件事的多个说法压成一条，`hits` 累加到保留的那条。
跑完会自己再检查一遍，确认没有残留（幂等）。

机器人运行中也能跑，但**建议先停掉**（避免和正在写入的记忆撞车）。
不想开终端的话，控制台也有同一个接口：

```
http://127.0.0.1:8787/api/memories/dedupe?scope=private&id=2000000001          # 预览
http://127.0.0.1:8787/api/memories/dedupe?scope=private&id=2000000001&apply=1  # 执行
```

### 她记得自己说过什么（`selfMemory`）

和上面那套是**两回事**，别混起来：

| | 长期记忆（`memory`） | 自身话记忆（`selfMemory`） |
| --- | --- | --- |
| 记什么 | **关于对方的**稳定事实（喜好、近况、关系） | **她自己这几天刚说过的话** |
| 存哪 | SQLite 永久 | 不存，每次直接从聊天记录里现取 |
| 解决什么 | "隔了三天他还记得我不吃香菜" | "我十分钟前才答应过的事，不会再郑重答应一遍" |

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `selfMemory.enabled` | true | 总开关 |
| `selfMemory.turns` | 8 | 回看最近几轮她自己说过的话 |
| `selfMemory.limit` | 8 | 最多注入几条 |
| `selfMemory.maxChars` | 400 | 这段提醒的总字数上限（从最近的往回塞） |
| `selfMemory.maxItemChars` | 60 | 单条超过就截断，避免她把整段独白背下来 |

**为什么需要它**：她连发的好几条气泡在模型眼里会被合并成**一条** assistant 消息。
一旦那条消息滑出上下文窗口，她就完全不知道自己答应过什么——实测出现过
**把同一件事又郑重答应一遍**和**编造"我们之间的过去"**两个症状。

注入时的措辞是刻意写成「**同一件事不要重复说、不要再答应一遍**」而不是「请保持前后一致」——
后者太软，模型不当回事（实测对比过）。

> 这里刻意**只提醒"你说了什么"，不让她把那些话当成真实世界的事实**。
> 长期记忆也刻意**不收她自己说的话**：编出来的"小传统"一旦固化进长期库就洗不掉了。
> 这两条是同一个原则：短期可以提醒，长期不能污染。

### 看图（`vision`）

她**能看见你发的图片**。之前不行不是模型不支持，是本地把图片地址扔了。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `vision.enabled` | true | 总开关 |
| `vision.maxImages` | 2 | 一条消息最多看几张图（设为 `0` 等于关掉） |
| `vision.maxBytes` | 5242880 | 单张图字节上限，超了就放弃（5MB） |
| `vision.timeoutMs` | 10000 | 下载超时 |
| `vision.cacheTtlMs` | 600000 | 同一地址的缓存时长，10 分钟内不重复下载 |

**工作方式**：NapCat 的图片段里带着可直接下载的 `url`（临时链接，会过期）→ 先下载到本地、
按魔术字节确认它真的是图（在线状态返回 HTML 错误页是常事）→ 转成 base64 的 data URL
→ 作为多模态内容附在**刚发的这条 user 消息**上。

> **成本**：DeepSeek 每张图最多算 **1024 token**。所以默认只带 2 张，而且**历史消息里的图不重复携带**——
> 否则每轮都要为老图再付一次 token。
>
> **能力边界（实测）**：看得懂这是什么图、什么场景、大致颜色、大号清晰文字；
> 具体数量和小字长文本（聊天截图、表格正文）会看走眼；**画面看不清时它会猜**——
> 所以代码里附了一句「看不清就说看不清，千万不要猜、不要编」，但不能保证 100% 生效。
> 另外 GIF 大概率只被看一帧，QQ 表情（face 段）只有数字 id、没有中文名。

单张图失败（超时、404、不是图片）**不会拦住整条回复**，只是这一条没有图。

### 安全兜底

`safety.blockedKeywords` 命中就**不调模型**、直接回固定话术（默认 `这个真不方便说`）。默认拦：转账、打钱、验证码、密码、银行卡、身份证、贷款、借钱。

---

## 六、验证与测试

```powershell
# 213 项单元 + 集成测试（全离线，用 mock NapCat 和 mock 模型）
npm test

# 冒烟测试：用 mock 起真实的 src/index.js，验证生产入口能跑通
npm run smoke

# 改完人设后对比新旧语气（会调真实模型，花钱很少）
npm run persona:compare

# 改完说话风格相关代码后，看句号/换行/气泡数的实际变化（会调真实模型）
npm run style:compare

# 清理存量重复记忆（默认只预览，不动库）
npm run dedupe -- --scope private --id 你的QQ号
```

测试全部离线，不碰真 QQ、不调真模型、不花钱。`persona:compare` 和 `style:compare` 例外——
它们就是要用真模型，才看得出语气变化。

---

## 七、文件结构

```
qq-ai-bot/
├── src/
│   ├── index.js       入口：装配 + 优雅退出
│   ├── bot.js         主流程：去重→落库→触发判断→模型→分段回发
│   ├── trigger.js     触发规则（纯函数，好测）
│   ├── llm.js         DeepSeek 调用 + 提示词 + 历史拼装
│   ├── store.js       SQLite 对话存储（node:sqlite）
│   ├── onebot.js      OneBot 11 WebSocket 客户端（重连/心跳/假死检测）
│   ├── ratelimit.js   三层限速
│   ├── segments.js    消息段解析 + 长文本切分
│   ├── awareness.js   实时感知：时区时间 + 天气（open-meteo，带缓存与退避）
│   ├── memory.js      长期记忆：异步抽取 + n-gram 检索
│   ├── textsim.js     判定"两条记忆是不是同一件事"（去重用的相似度）
│   ├── vision.js      看图：下载图片 → 校验 → data URL 交给多模态模型
│   ├── control.js     控制台 HTTP API
│   └── config.js      配置加载/合并/校验
├── config/
│   ├── config.example.json   配置模板
│   ├── persona.example.md    人设模板（示例=流萤），复制成 persona.md 生效
│   └── persona.md            你实际生效的人设（已 .gitignore）
├── scripts/
│   ├── smoke.mjs            冒烟测试
│   ├── backup.mjs           备份数据库（VACUUM INTO）
│   ├── dedupe-memories.mjs  清理存量重复记忆（默认只预览）
│   ├── persona-compare.mjs  改完人设后逐场景对比新旧语气
│   └── style-compare.mjs    改完风格代码后对比句号/换行/气泡数
└── test/
```

数据库落在 `data/bot.db`，默认保留 30 天，每 6 小时自动清理过期记录。

---

## 八、常见问题

**连不上 NapCat**
先确认 NapCat 里 WebSocket 服务器是不是开着、端口对不对。`ws://127.0.0.1:3001` 这种地址在浏览器里打不开是正常的（它是 WebSocket 不是 HTTP）。

**群里 @ 了没反应**
1. 看日志有没有 `已登录账号`
2. 看 `GET /api/status` 的 `paused` 是不是 `true`
3. 确认 NapCat 的消息格式设成了 **array**
4. 是不是在静默时段、或者你刚手打过（接管退避中）

**它回得太快/太多**
嫌回得太快：看上面的 `typing` 一节，调大 `typing.reactMinMs`/`reactMaxMs`/`perCharMs`。
嫌回得太多：调大 `rateLimit.perSessionMinIntervalMs`，调小 `rateLimit.globalPerMinute`。

**它还是一大坨 / 句号还是太多**
人设和代码得一起改，只改一边会被另一边抵消（**她自己的历史就是最强的风格范例**）：
1. 先看历史里干不干净——`buildMessages` 的 `tidyAssistant` 和 `bot.js` 的 `tidySelfText`
   会清洗句号，确认你没把这两个开关关掉；
2. 再看人设有没有教她「想分两句就**换行**」——只写"不要打句号"她会改用逗号连成一长串；
3. 改完跑 `npm run style:compare` 看句号数/换行数/气泡数的实际变化，别凭感觉。

**它有时候要等十几秒才回**
先分清是**模型慢**还是**程序在等**——`GET /api/status` 的 `latency` 段会给出拆分：

```
latency.last = { modelMs: 12417, thinkMs: 0, chars: 43 }   ← 模型自己就花了 12 秒
latency.last = { modelMs: 900, thinkMs: 2685, chars: 45 }  ← 模型 0.9 秒，程序故意等了 2.7 秒
```

- `thinkMs` 是打字延迟，嫌久就调小 `typing.perCharMs` / `typing.maxDelayMs`；
- `modelMs` 大是网络或 DeepSeek 自己慢，可以调小 `context.maxChars`（少喂点上下文）
  或把 `llm.timeoutMs` 调小让它早点放弃；
- `latency.recent` 是最近 20 条，日志里也会有 `打字延迟 Xms（回复 N 字，模型已耗时 Mms…）`。

**它回得太慢了**
把 `typing.enabled` 改成 `false` 即恢复秒回；或者只调小 `typing.perCharMs` 和 `typing.maxDelayMs`。
另外如果模型本身慢（网络差）时感觉"没补延迟"，那是正常的——生成耗时已经从预算里扣掉了。

**说话不像我**
用写法 A：改 `config/persona.md` 的正文，塞几个你常说的话的例子效果最好。用写法 B 就改
`persona.description` 和 `persona.style`。

**群里陌生人也被叫"开拓者"/被撒娇**
在 `config/config.json` 里把 `owner.qq` 填成你自己的大号。留空时程序**不认为任何人**是开拓者，
只会走"普通群友"语境（所以不会亲近，但也不会错认）。

**它私聊不理我**
私聊默认是关的。把 `trigger.private.enabled` 改成 `true`，并且把你的号填进
`trigger.private.whitelist`。

**它记不住我刚说的话**
检索是**看字面重合**的（2-gram 词面匹配），不是语义理解。你换了说法它就想不起来。
想验证它到底记住了什么：`GET /api/memories?scope=private&id=你的QQ号`；
想验证某句话能召回哪些：`GET /api/memories/search?scope=private&id=你的QQ号&q=吉他`。
觉得太难召回就把 `memory.minScore` 从 `2` 调到 `1`（代价是经常乱提旧事）。

**它老把同一件事再说一遍 / 又答应一次，或者编造"我们以前……"**
这是"她看不见自己说过的话"造成的，见上面的 `selfMemory` 一节。要更保险就把
`selfMemory.turns` 从 8 调大（代价是多占窗口），并且确认 `context.privateTurns`
别设得太小——窗口按**轮**取之后，一轮的内容才不会被切成半截。

**它聊着聊着开始反复提同一个东西（比如某道菜）**
两种可能，先分清：
1. **她说的话自己的多气泡把窗口挤满** → 看 `selfMemory` 和 `context.*Turns` 两节。
2. **长期记忆里同一件事存了 4~5 个变体**（检索时 6 个名额被同一件事占满，
   模型会判定"这条特别重要"从而反复提）。用
   `GET /api/memories?scope=private&id=你的QQ号` 看一眼有没有近似重复；
   有就一次清干净：
   ```powershell
   npm run dedupe -- --scope private --id 你的QQ号          # 先预览
   npm run dedupe -- --scope private --id 你的QQ号 --apply   # 再执行
   ```
   新写入的记忆已经有三层自动去重（见「同一件事被记成好几条怎么办」一节），
   这个命令是用来清历史遗留的。

**它说的天气是错的**
1. `POST /api/weather-refresh` 手动拉一次，看服务端日志有没有报错
2. 检查 `awareness.location.latitude`/`longitude` 是不是填成了默认的杭州
3. 天气是**每 30 分钟**才更新一次，不是实时的——这不影响聊天，但别拿它对时间表

**它说的时间不对**
检查 `awareness.timezone`。默认 `Asia/Shanghai`，在境外要改（比如 `Asia/Tokyo`）。
时间取自本机系统时钟，先确认电脑时间是对的。

**私聊里没看到"对方正在输入…"**
1. 只有**私聊**能显示——群聊做不到（NapCat 的 `set_input_status` 只支持私聊）。
2. 停顿必须够长：`inputStatus.minDelayMs` 默认 800ms，短回复（比如"嗯"）根本不会触发。
3. 你把 `logLevel` 设成 `debug` 重启，看有没有 `已发送「正在输入」提示`；
   如果那行是 `发送失败（不影响回复）`，多半是 NapCat 版本太老没这个扩展动作——
   升级 NapCat 即可，或者把 `inputStatus.enabled` 设成 `false` 不再管它。

**它开始胡扯**
调低 `llm.temperature`（比如 0.8），或者在 `persona.md` 里把行为准则写得更严（写法 B 则是 `persona.rules`）。

**我手机上自己回了一句，它还在插话**
确认 NapCat 里那个 WebSocket 服务器勾上了 **「上报自身消息 / reportSelfMessage」**。不开的话
NapCat 不会把你自己发的消息告诉程序，程序就不知道你接管了。开了之后，程序会区分「你手打的」
和「AI 自己刚发的」（按 message_id 比对），不会出现 AI 把自己当成你然后闭嘴 10 分钟的情况。

**想立刻停**
浏览器开 `http://127.0.0.1:8787/api/pause`，或者直接 Ctrl+C。
