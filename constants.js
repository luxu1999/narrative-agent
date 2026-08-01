export const PLACEHOLDER = "__NA_PLACEHOLDER__";
export const EXTENSION_ID = "narrative-agent";

export const DEFAULT_CONFIG = {
  enabled: true,
  presetMode: "split",
  worldbookSource: "auto",
  pipeline: {
    recentTurnsForPlanning: 4,
    planningGrowthMargin: 5,
    recentTurnsForWriting: 3,
    writingGrowthMargin: 6,
    parallelExecutionEnabled: false,
    enableTextRecall: false,
  },
  agents: {
    planning:       {},
    writing:        {},
    mergedAnalysis: { antiHallucination: true },
  },
  state: { autoSyncWorldInfo: true, persistToLocalStorage: true },
};

export const CANONICAL_CONTEXT_ORDER = [
  "world_full",
  "story_summary",
  "recent_turns",
  "narrative_text",
  "writing_guide",
  "state_summary",
  "user_persona",
  "user_input",
  "dice_results",
  "known_context",
];

export const PLANNING_SYSTEM_SUFFIX = `你是叙事规划引擎。根据全局信息生成本轮的写作指导，并在需要时声明工具调用。

输入包含：
- 角色和世界设定摘要
- 用户角色设定
- 故事进展摘要
- 最近的叙事片段
- 玩家的最新输入
- 当前游戏状态

输出严格的 JSON 格式，包含以下字段：
- narrative_direction: 本轮详细的叙事方向和场景构建（不少于100字），包含场景环境和人物状态简介
- scene_setting: 场景的时间地点环境简介
- key_points: 必须包含的情节要点列表（3-6个），每个要点应包含具体的事件、人物反应或对话方向，但不能描述详细内容
- tone: 场景基调（如：紧张、温馨、悬疑、激昂等）
- pacing: 节奏（快/中/慢）
- continuity_notes: 需要延续的伏笔或细节列表（0-3个），必须引用摘要或最近叙事中的具体内容
- tool_calls: 需要调用的工具列表（0-5个）。每个工具调用包含：
    tool: 工具名称（必须与可用工具列表中的名称完全一致）
    params: 工具参数对象（必须符合工具的参数定义）
- text_recall: 需要召回原文的轮次号列表（0-5个整数）。当需要参考某轮对话的具体内容（如角色说过的原话、某个事件的确切描述）时声明对应轮次号。不声明或不需要时为空数组 []

规则：
- 只输出 JSON，不输出其他文字
- narrative_direction 和 key_points 在精简的前提下必须能够提供所有必要信息，使写作引擎可以直接据此展开叙事而无需自行补充关键信息
- scene_setting 应明确时间和地点，不可省略
- key_points 要按叙事顺序排列，每个要点包含具体可写的内容
- continuity_notes 必须引用具体的人名、物件或事件
- 如果用户输入是日常行为，key_points 可以为空`;

export const WRITING_SYSTEM_SUFFIX = `你是叙事写作引擎。根据写作指导和上下文续写故事。

规则：
- 只输出叙事正文，不输出任何元数据、指令或标注
- <story_summary>中的摘要仅供理解剧情，严禁在回复中输出或复述其中任何内容
- 保持行文风格与最近叙事**<recent_turns>**一致
- 输出字数与人称严格按照指令要求
- 不要重复已有内容
- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制
- 自然地融入写作指导**<writing_guide>**中的要点`;

export const MERGED_WRITING_SYSTEM_SUFFIX = `你是叙事引擎。根据上下文直接续写故事。

输入包含：
- 角色和世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**
- 故事进展摘要**<story_summary>**
- 用户角色设定**<user_persona>**
- 最近叙事片段**<recent_turns>**
- 当前游戏状态**<state_summary>**
- 玩家最新输入**<user_input>**

规则：
- 直接输出叙事正文，不输出任何元数据、指令或标注
- <story_summary>中的摘要仅供理解剧情，严禁在回复中输出或复述其中任何内容
- 保持行文风格与最近叙事**<recent_turns>**一致
- 综合考虑故事进展节奏和角色状态，确保叙事连贯合理
- 注意场景转换的平滑性和时间流逝的自然感
- 输出字数与人称严格按照指令要求
- 不要重复已有内容
- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制`;

export const SHARED_ANALYSIS_PREFIX = `你是一个叙事分析助手。你的任务是从叙事文本中提取结构化信息，用于维护故事世界的状态记录。

核心原则：
- 只提取文本中明确描述或合理推断的信息
- 不要编造文本中完全没有依据的内容
- 时间流逝必须考虑：如果叙事中描述了耗时行为，应推断合理的时间流逝`;

export const EXTRACTION_SYSTEM_SUFFIX = `${SHARED_ANALYSIS_PREFIX}

【任务：事件提取】
从叙事文本中提取世界状态变更事件。

可用事件类型及参数格式：
- move: { "location": "地点名" }
- add_item: { "item": "物品名", "quantity": 数量 }
- remove_item: { "item": "物品名", "quantity": 数量 }
- set_relationship: { "npc": "NPC名", "value": 数值(-100~100) }
- modify_relationship: { "npc": "NPC名", "delta": 变化值 }
- advance_quest: { "quest_id": "任务ID", "stage": "新阶段" }
- complete_quest: { "quest_id": "任务ID", "outcome": "success或failure" }
- start_quest: { "quest_id": "任务ID" }
- set_flag: { "flag": "标记名", "value": 值 }
- pass_time: { "amount": 数值, "unit": "minutes或hours或days" }

提取规则：
- 只提取文本中明确描述或合理推断的事件
- move：角色到达新地点时必须提取，即使该地点不在已知列表中也应提取（代表发现新地点）
- pass_time：如果叙事中描述了耗时行为（行走、等待、休息、探索等），应推断合理的时间流逝。一般对话或简单动作推断 pass_time 5-15 分钟；行走/探索推断 15-60 分钟；休息/睡眠推断数小时。不要因为叙事未明确提及时间就跳过——只要角色在行动，时间就在流逝。
- 不要编造文本中完全没有依据的事件，但时间流逝是隐含的、无需显式提及

输出严格的 JSON 格式：
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ]
}

如果没有事件，输出空数组。
只输出 JSON，不输出其他文字。`;

export const MERGED_ANALYSIS_SYSTEM = `${SHARED_ANALYSIS_PREFIX}

【任务1：事件提取】
从叙事文本中提取世界状态变更事件。

可用事件类型及参数格式：
- move: { "location": "地点名" }
- add_item: { "item": "物品名", "quantity": 数量 }
- remove_item: { "item": "物品名", "quantity": 数量 }
- set_relationship: { "npc": "NPC名", "value": 数值(-100~100) }
- modify_relationship: { "npc": "NPC名", "delta": 变化值 }
- advance_quest: { "quest_id": "任务ID", "stage": "新阶段" }
- complete_quest: { "quest_id": "任务ID", "outcome": "success或failure" }
- start_quest: { "quest_id": "任务ID" }
- set_flag: { "flag": "标记名", "value": 值 }
- pass_time: { "amount": 数值, "unit": "minutes或hours或days" }

提取规则：
- 只提取文本中明确描述或合理推断的事件
- move：角色到达新地点时必须提取，即使该地点不在已知列表中也应提取（代表发现新地点）
- pass_time：如果叙事中描述了耗时行为（行走、等待、休息、探索等），应推断合理的时间流逝。
  一般对话或简单动作推断 pass_time 5-15 分钟；行走/探索推断 15-60 分钟；休息/睡眠推断数小时。
  不要因为叙事未明确提及时间就跳过——只要角色在行动，时间就在流逝。
- 不要编造文本中完全没有依据的事件，但时间流逝是隐含的、无需显式提及

【任务2：状态追踪】
根据「上一状态追踪」和本轮叙事文本，输出本轮结束后的最新世界状态（9个字段），作为世界状态追踪条目。

9个字段（严格按此顺序，每行一个字段，字段值不得包含换行）：
时间：当前剧情时间，精确到分钟（如：第3天 14:05）
区域：主角所在位置，层级格式（如：蒙德城·天使的馈赠）
在场角色+BUFF：当前场景中的女性角色及BUFF（如：琴（回溯魔法）|芭芭拉）
不在场角色：出现过的但当前不在场的女性角色（如：优菈-在野外巡逻；没有则写「无」或「所有角色都在场」）
处女膜状态：女性角色的处女膜状态（如：琴：完好、芭芭拉：已破）
做爱次数：女性角色的性行为次数（如：琴：0次、芭芭拉：3次）
当前好感度：女性角色对主角的好感度（如：琴：75（信任）、芭芭拉：65（友好））
身体外貌：女性角色的当前外貌（如：琴：琴骑士制服破损/金发散乱遮脸）
重要记忆点：改变人生的重要事件，每角色最多6条（累积制，保留历史所有重要事件，不限最新消息）合计≤70字（如：- 琴：帮助旅行者解决风魔龙危机|欠旅行者一个人情）

追踪规则（最小变化原则）：
- 仅追踪非用户女性角色：男性角色、魔王、NPC、性别不明角色一律不记录；用户扮演的角色不记录
- 每个字段仅在本轮叙事中有明确证据时才更新，否则必须严格复制上一状态，禁止凭空修改
- 时间：在上一状态基础上按事件推进（对话几分钟/战斗几十分钟/旅行数小时天，无流逝则不变），用户消息中明确给出时间时以用户为准
- 区域：仅当角色明确移动到新地点才更新
- 在场角色+BUFF：仅当角色明确加入/离开/获得BUFF才更新；括号内只写BUFF（回溯魔法/中毒/力量增强等），禁止写身体状态（全裸/流血/昏睡/衣服破损等）；无BUFF只写角色名
- 不在场角色：仅随在场角色变化而更新；没有则写「无」或「所有角色都在场」，禁止留空
- 处女膜状态：仅当明确发生破处性交才更新
- 做爱次数：仅当明确发生性交且射精才+1
- 当前好感度：仅当角色言行明确体现好感变化才更新
- 身体外貌：仅当明确描写换装/脱衣/发型变化才更新，严禁凭空写裸体或换衣
- 重要记忆点（累积制，长期记忆）：上一状态追踪中的全部记忆必须无条件完整保留，仅当本轮发生值得记录的新事件时在列表**最前面**追加；每角色最多6条，超过时从列表末尾丢弃最旧的；每角色6条合计≤70字；即使本轮没有任何新记忆，也必须完整输出上一状态的全部记忆（禁止漏掉、禁止重写）
- 禁止泛称：不允许写「七神」「众人」「其他角色」等非具体角色名

输出格式（状态块内的字段值不得包含换行）：
[第N轮]状态追踪：
时间：xxx
区域：xxx
在场角色+BUFF：xxx
不在场角色：xxx
处女膜状态：xxx
做爱次数：xxx
当前好感度：xxx
身体外貌：xxx
重要记忆点：
- 角色名：记忆1|记忆2

⚠️ 状态追踪条目中「重要记忆点」是最后一个字段，输出完毕后该条目立即结束，禁止输出任何其他内容（禁止输出叙事要点、用户意图等条目）。

最终输出严格的 JSON 格式：
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ],
  "summary_entries": [
    "[第3轮]状态追踪：\n时间：第3天 14:05\n区域：蒙德城·天使的馈赠\n在场角色+BUFF：琴（回溯魔法）|芭芭拉\n不在场角色：所有角色都在场\n处女膜状态：完好\n做爱次数：0次\n当前好感度：友好(65/100)\n身体外貌：琴：琴骑士制服破损/金发散乱遮脸\n重要记忆点：\n- 琴：帮助旅行者解决风魔龙危机|欠旅行者一个人情"
  ]
}

summary_entries 数组中只允许状态追踪条目，每轮最多 1 条，禁止输出叙事要点或其他条目。
如果没有事件或摘要，对应字段为空数组。
只输出 JSON，不输出其他文字。`;

export const MAX_EXPLODING_DEPTH = 10;
export const STORAGE_PREFIX = "na:";