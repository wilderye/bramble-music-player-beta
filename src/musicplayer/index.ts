console.log('音乐播放器脚本9.2.2版本');

// =================================================================
// 0. 诊断工具 (Diagnostic Tools)
// =================================================================
import { z, ZodError } from 'zod';
declare global {
  interface Window {
    musicPlayerAPI: any;
  }
}
const SCRIPT_LOAD_TIME = performance.now();

function logProbe(message: string, type: 'log' | 'warn' | 'error' | 'group' | 'groupCollapsed' | 'groupEnd' = 'log') {
  const timestamp = `(T+${(performance.now() - SCRIPT_LOAD_TIME).toFixed(0)}ms)`;
  const finalMessage = `${timestamp} ${message}`;

  switch (type) {
    case 'warn':
      console.warn(finalMessage);
      break;
    case 'error':
      console.error(finalMessage);
      break;
    case 'group':
      console.group(finalMessage);
      break;
    case 'groupCollapsed':
      console.groupCollapsed(finalMessage);
      break;
    case 'groupEnd':
      console.groupEnd();
      break;
    default:
      console.log(finalMessage);
  }
}

// =================================================================
// 1. 类型定义 (Type Definitions)
// =================================================================

type PlaylistItem = {
  url: string;
  歌名: string;
  歌手?: string;
  封面?: string;
};

type PlaylistConfig = {
  id: string;
  tracks: PlaylistItem[];
  onFinishRule: 'loop' | 'pop';
};

type QueueItem = {
  // --- 核心标识与排序依据 ---
  playlistId: string;
  priority: number;

  // --- 内容与规则 ---
  playlistContent: PlaylistItem[];
  onFinishRule: 'loop' | 'pop';

  // --- 状态记忆 ---
  currentIndex: number;
  playedIndices: Set<number>;
  playbackPlan?: number[];
  planIndex?: number;
  wasEverPlayed: boolean;

  // --- 溯源信息 ---
  triggeredBy: 'base' | 'mvu';
  triggerSource?: z.infer<typeof ZodTriggerConfig>;
};

type PlaybackMode = 'list' | 'single' | 'random';

type FullStatePayload = {
  currentItem: { title: string; artist?: string; cover?: string } | null;
  isPlaying: boolean;
  playbackState: 'STOPPED' | 'PLAYING' | 'PAUSED';
  playbackMode: PlaybackMode;
  masterVolume: number;
  playlist: { title: string; artist?: string; cover?: string }[];
  isTransitioning: boolean;
};

type TimeUpdatePayload = {
  currentTime: number;
  duration: number;
};

type StrategyDecision = {
  action: 'GoTo' | 'RemoveTopAndAdvance' | 'Restart' | 'DoNothing' | 'LoopReset' | 'Stop';
  nextIndex?: number;
};

interface IPlaybackStrategy {
  onQueueChanged(currentItem: QueueItem | undefined): void;
  advance(currentItem: QueueItem, direction: 'next' | 'prev'): StrategyDecision;
  onTrackEnd(currentItem: QueueItem): StrategyDecision;
  onPlaybackError(currentItem: QueueItem): StrategyDecision;
}

// =================================================================
// 1.1. Zod 边界防御 Schemas (Zod Border Defense Schemas)
// -----------------------------------------------------------------
// 探针: 这些 schemas 不仅仅是类型，它们是主动的验证器，是我们系统的第一道防线。
//       每一个 `required_error` 和 `message` 都是一个内置的探针，当外部数据
//       不符合我们的“法律”时，它们会自动报告错误。
// 原则: 单一事实来源 (SSoT) - 关于外部数据应该长什么样的“真相”，只由这里定义。
// =================================================================

// 世界书音轨配置 Schema
export const ZodTrackConfig = z
  .object({
    歌名: z.string().optional(),
    歌手: z.string().optional(),
    封面: z.string().url({ message: '封面URL格式无效' }).optional(),
    url: z.string().url({ message: '音轨URL格式无效' }),
  })
  .strict();

// 定义一个“单一条件”
export const ZodSingleCondition = z
  .object({
    variable_path: z.string(),
    greater_than: z.number().optional(),
    greater_than_or_equal_to: z.number().optional(),
    less_than: z.number().optional(),
    less_than_or_equal_to: z.number().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    value_contains: z.string().optional(),
    time_in_range: z
      .string()
      .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, {
        message: '时间范围格式必须是 "HH:MM-HH:MM"',
      })
      .optional(),
  })
  .strict();

// 主触发器 Schema 引用“单一条件”的数组
export const ZodTriggerConfig = z
  .object({
    type: z.literal('mvu_variable'),
    playlist_id: z.string(),
    priority: z.number().default(0),
    conditions: z.array(ZodSingleCondition).nonempty({ message: '触发器必须至少包含一个条件' }),
  })
  .strict();

// 世界书歌单配置 Schema
export const ZodPlaylistConfig = z.object({
  id: z.string(),
  onFinishRule: z.enum(['loop', 'pop'], { message: "onFinishRule 必须是 'loop' 或 'pop'" }).default('loop'),
  tracks: z.array(ZodTrackConfig).nonempty({ message: "歌单的 'tracks' 列表不能为空" }),
});

// 世界书总配置 Schema (这是我们将使用的顶级验证器)
export const ZodWorldbookConfig = z
  .object({
    default_playlist_id: z.string().optional(),
    playlists: z.array(ZodPlaylistConfig).optional(),
    triggers: z.array(ZodTriggerConfig).optional(),
    is_mvu: z.boolean().optional(),
  })
  .strict();

// 持久化状态 - 队列项 Schema
export const ZodQueueItemState = z.object({
  playlistId: z.string(),
  currentIndex: z.number().default(0),
  playedIndices: z.array(z.number()).default([]),
  wasEverPlayed: z.boolean().default(false),
  triggerSource: ZodTriggerConfig.optional(),
});

// 持久化状态 - 总 Schema
export const ZodPersistedState = z.object({
  active_queue: z.array(ZodQueueItemState),
  mode: z.enum(['list', 'single', 'random']).default('list'),
  volume: z.number().min(0).max(1).default(0.5),
  last_active_swipe_id: z.number().nullable().default(null),
  finished_base_playlists: z.array(z.string()).default([]),
  previousMvuState: z.record(z.string(), z.any()).optional(),
});

const STATE_KEY_MVU_HISTORY = '灰烬双星_MVU状态记忆';

/**
 * [工具函数] 将多种格式的时间字符串解析为从午夜开始的分钟数。
 * 它的职责单一，且对输入格式有很强的容错能力。
 * @param timeStr - 例如 "14:30", "8时5分", "22 : 00"
 * @returns {number | null} 转换后的分钟数，或在无法解析时返回 null。
 */
function _parseTimeToMinutes(timeStr: string): number | null {
  // 探针: 记录传入的原始值，便于调试
  if (!timeStr || typeof timeStr !== 'string') return null;

  // 步骤1: 归一化输入，处理常见变体 (已修正 let -> const 和 replace 语法)
  const cleanStr: string = timeStr.trim().replace('：', ':');

  let match;

  // 步骤2: 尝试匹配 "HH:MM" 格式 (最常见)
  match = cleanStr.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    // 严格校验数值范围
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      return hours * 60 + minutes;
    }
  }

  // 步骤3: 尝试匹配 "H时M分" 格式
  match = cleanStr.match(/^(\d{1,2})\s*时\s*(\d{1,2})\s*分?$/);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      return hours * 60 + minutes;
    }
  }

  // 探针: 如果所有格式都匹配失败，记录下来
  logProbe(`[TimeParser] 无法解析时间字符串: "${timeStr}"`, 'warn');

  // [新增] 修复“缺少 return”的逻辑漏洞
  return null;
}

// =================================================================
// 2. MVU 管理器 (The MvuManager - "The Analyst")
// =================================================================
const MvuManager = (() => {
  logProbe('[MvuManager] 模块正在初始化...');

  let _previousMvuState: Record<string, any> = {};

  /**
   * [核心算法 V2.1] 检查一个给定的 stat_data 是否满足一个触发器的所有条件。
   * 新版已加固，支持多种匹配模式和 AND 条件组合，且代码风格已优化。
   */
  function _checkTriggerCondition(
    trigger: z.infer<typeof ZodTriggerConfig>,
    statData: Record<string, any> | null,
  ): boolean {
    if (!statData) return false;

    // 遍历所有 AND 条件。只要有一个不满足，整个触发器就失败。
    for (const condition of trigger.conditions) {
      const currentValue = _.get(statData, condition.variable_path);

      let conditionMet = false; // 当前条件是否满足
      let isHandled = false; // 当前条件是否被任何一个匹配模式处理过

      // 使用 if / else if 链条，确保每个条件项只采用一种匹配模式
      if (condition.value_contains !== undefined) {
        isHandled = true;
        // [安全加固] 必须检查 currentValue 是字符串，否则 .includes() 会导致崩溃
        if (typeof currentValue === 'string' && currentValue.includes(condition.value_contains)) {
          conditionMet = true;
        }
      } else if (condition.time_in_range !== undefined) {
        isHandled = true;
        // [安全加固] 同样检查类型
        if (typeof currentValue === 'string') {
          const currentTimeInMinutes = _parseTimeToMinutes(currentValue);

          if (currentTimeInMinutes !== null) {
            const [startStr, endStr] = condition.time_in_range.split('-');
            const startMinutes = _parseTimeToMinutes(startStr);
            const endMinutes = _parseTimeToMinutes(endStr);

            if (startMinutes !== null && endMinutes !== null) {
              // [代码风格修正] 移除不必要的嵌套 if，使代码更简洁
              if (startMinutes <= endMinutes) {
                // 普通范围
                conditionMet = currentTimeInMinutes >= startMinutes && currentTimeInMinutes <= endMinutes;
              } else {
                // 跨天范围
                conditionMet = currentTimeInMinutes >= startMinutes || currentTimeInMinutes <= endMinutes;
              }
            }
          }
        }
      } else if (condition.value !== undefined) {
        isHandled = true;
        if (currentValue === condition.value) {
          conditionMet = true;
        }
      } else if (condition.greater_than !== undefined) {
        isHandled = true;
        if (typeof currentValue === 'number' && currentValue > condition.greater_than) {
          conditionMet = true;
        }
      } else if (condition.greater_than_or_equal_to !== undefined) {
        isHandled = true;
        if (typeof currentValue === 'number' && currentValue >= condition.greater_than_or_equal_to) {
          conditionMet = true;
        }
      } else if (condition.less_than !== undefined) {
        isHandled = true;
        if (typeof currentValue === 'number' && currentValue < condition.less_than) {
          conditionMet = true;
        }
      } else if (condition.less_than_or_equal_to !== undefined) {
        isHandled = true;
        if (typeof currentValue === 'number' && currentValue <= condition.less_than_or_equal_to) {
          conditionMet = true;
        }
      }

      // [最终裁决] 如果这是一个空条件 (isHandled=false)，或条件不满足，则立即失败
      if (!isHandled || !conditionMet) {
        return false;
      }
    }

    // 如果循环正常结束，说明所有 AND 条件都满足
    return true;
  }

  // --- 公共接口 ---
  const publicAPI = {
    checkTriggerCondition: _checkTriggerCondition,

    /**
     * [生命周期] 从酒馆变量中读取并恢复上一次的 MVU 状态。
     */
    initialize() {
      logProbe('[MvuManager] (Lifecycle) 执行 initialize...');
      try {
        const savedState = getVariables({ type: 'chat' })[STATE_KEY_MVU_HISTORY];
        if (savedState && typeof savedState === 'object') {
          _previousMvuState = savedState;
          logProbe('[MvuManager] 成功从存档中恢复了 MVU 历史状态。');
        } else {
          _previousMvuState = {};
          logProbe('[MvuManager] 未发现有效的 MVU 历史存档，已初始化为空状态。', 'warn');
        }
      } catch (error) {
        logProbe(`[MvuManager] 初始化时读取存档失败: ${error}`, 'error');
        _previousMvuState = {};
      }
    },

    resetState() {
      logProbe('[MvuManager] (Lifecycle) 正在重置模块内部状态...');
      _previousMvuState = {};
      logProbe('[MvuManager] 模块状态已重置。');
    },

    /**
     * [命令] 将当前的 MVU 状态持久化到酒馆变量中。
     * @param currentStateData - 最新的 stat_data 对象。
     */
    async persistCurrentState(currentStateData: Record<string, any>) {
      if (!isScriptActive) {
        logProbe('[MvuManager] 持久化操作被阻止，因为脚本正在停机。', 'warn');
        return;
      }
      logProbe('[MvuManager] (Command) 执行 persistCurrentState...');
      _previousMvuState = _.cloneDeep(currentStateData);
      try {
        await updateVariablesWith(
          vars => {
            vars[STATE_KEY_MVU_HISTORY] = _previousMvuState;
            return vars;
          },
          { type: 'chat' },
        );
        logProbe('[MvuManager] 已成功将当前 MVU 状态持久化。');
      } catch (error) {
        logProbe(`[MvuManager] 持久化 MVU 状态时发生严重错误: ${error}`, 'error');
      }
    },

    /**
     * [查询] 获取内存中存储的上一次的 MVU 状态。
     */
    getPreviousState: () => _.cloneDeep(_previousMvuState),

    /**
     * [核心查询] 计算新旧状态之间的“边沿变化”。
     * @param previousStateData - 上一次的 stat_data。
     * @param currentStateData - 最新的 stat_data。
     * @param allTriggers - 从世界书解析出的所有有效触发器。
     * @returns 报告对象，包含新激活和新失效的触发器列表。
     */
    calculateChangeReport(
      previousStateData: Record<string, any>,
      currentStateData: Record<string, any>,
      allTriggers: z.infer<typeof ZodTriggerConfig>[],
    ): {
      newlyActiveTriggers: z.infer<typeof ZodTriggerConfig>[];
      newlyInactiveTriggers: z.infer<typeof ZodTriggerConfig>[];
    } {
      const report: {
        newlyActiveTriggers: z.infer<typeof ZodTriggerConfig>[];
        newlyInactiveTriggers: z.infer<typeof ZodTriggerConfig>[];
      } = { newlyActiveTriggers: [], newlyInactiveTriggers: [] };

      logProbe('[MvuManager] (Query) 正在计算状态变化报告 ("边沿检测")...', 'group');

      logProbe('[Probe] 正在审查用于对比的新旧状态数据:');
      console.log('上一份历史记忆 (previousStateData):');
      console.dir(_.cloneDeep(previousStateData));
      console.log('当前权威状态 (currentStateData):');
      console.dir(_.cloneDeep(currentStateData));
      // =======================================================

      for (const trigger of allTriggers) {
        const wasMet = _checkTriggerCondition(trigger, previousStateData);
        const isMet = _checkTriggerCondition(trigger, currentStateData);

        if (!wasMet && isMet) {
          logProbe(`(探針) 新激活的触发器 -> playlist: "${trigger.playlist_id}"`);
          report.newlyActiveTriggers.push(trigger);
        } else if (wasMet && !isMet) {
          logProbe(`(探針) 新失效的触发器 -> playlist: "${trigger.playlist_id}"`);
          report.newlyInactiveTriggers.push(trigger);
        }
      }
      logProbe(
        `报告生成完毕: ${report.newlyActiveTriggers.length} 个新激活, ${report.newlyInactiveTriggers.length} 个新失效。`,
      );
      logProbe('', 'groupEnd');
      return report;
    },
  };

  logProbe('[MvuManager] 模块初始化完成。');
  return publicAPI;
})();

// =================================================================
// 2.X. 文本标签管理器 (The TextTagManager - "The Bard")
// =================================================================
/**
 * 职责 (SRP): 仅负责从历史文本中解析 <scene:xxx> 标签，将其转化为标准化的状态对象。
 * 它不负责播放，不负责决策，只负责“阅读”和“翻译”。
 */
const TextTagManager = (() => {
  logProbe('[TextTagManager] 模块正在初始化 (吟游诗人引擎)...');

  // 正则表达式：匹配 <scene: id >，允许冒号后有空格，捕获 id 部分
  // 使用 'g' 标志以便我们在同一条消息中查找最后一个匹配项
  const SCENE_TAG_REGEX = /<scene:\s*([^>]+)\s*>/g;

  /**
   * [核心算法] 滑动窗口回溯扫描。
   * 性能: O(1) - 无论聊天记录多长，最多只拉取最近 20 条。
   */
  async function _getLatestState(): Promise<Record<string, any>> {
    logProbe('[TextTagManager] (Query) 开始执行文本回溯扫描...', 'groupCollapsed');

    try {
      // 1. 确定锚点
      const latestMsgs = getChatMessages(-1);
      if (!latestMsgs || latestMsgs.length === 0) {
        logProbe('[TextTagManager] 无法获取最新消息锚点，返回空状态。', 'warn');
        logProbe('', 'groupEnd');
        return { 'virtual.music_tag': null };
      }

      const lastId = latestMsgs[0].message_id;

      // 2. 计算窗口 (最近 20 条)
      const startId = Math.max(0, lastId - 19);
      const rangeString = `${startId}-${lastId}`;
      logProbe(`(探针) 扫描窗口确定: ${rangeString} (锚点ID: ${lastId})`);

      // 3. 获取切片
      const msgs = getChatMessages(rangeString);

      // 4. 倒序遍历
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];

        // [过滤] 严格忽略用户的输入，防止用户通过发送标签操控 BGM
        if (msg.role === 'user') {
          continue;
        }

        // [解析] 在当前消息中寻找标签
        // 逻辑: "Last Match Wins" (同一条消息里如果有多个标签，取最后一个)
        const allMatches = [...msg.message.matchAll(SCENE_TAG_REGEX)];

        if (allMatches.length > 0) {
          // 取最后一个匹配项
          const lastMatch = allMatches[allMatches.length - 1];
          const rawId = lastMatch[1].trim();

          // [归一化] 强制转小写，以匹配隐式生成的触发器
          // 如果 ID 是 "null" (不分大小写)，则视为明确的“停止/空”指令
          if (rawId.toLowerCase() === 'null') {
            logProbe(`[TextTagManager] 在 message_id: ${msg.message_id} 找到明确的空指令 <scene:null>。`);
            logProbe('', 'groupEnd');
            return { 'virtual.music_tag': null };
          }

          const normalizedId = rawId.toLowerCase();
          logProbe(
            `[TextTagManager] 命中! 在 message_id: ${msg.message_id} 找到标签: "${rawId}" -> 归一化: "${normalizedId}"`,
          );
          logProbe('', 'groupEnd');
          return { 'virtual.music_tag': normalizedId };
        }

        // [规则] 遇到第一条 AI 消息，即使没有标签，也必须停止扫描。
        // "无标签即停止"原则：这意味着场景歌单的生命周期仅维持在有标签的那一楼。
        // 这种设计避免了为了找一个标签而无限回溯历史。
        logProbe(
          `[TextTagManager] 在 message_id: ${msg.message_id} (AI) 中未发现标签。根据“无标签即空”原则，扫描结束。`,
        );
        logProbe('', 'groupEnd');
        return { 'virtual.music_tag': null };
      }

      // 5. 兜底
      logProbe('[TextTagManager] 扫描完窗口内所有消息，未发现有效 AI 消息。返回空状态。');
      logProbe('', 'groupEnd');
      return { 'virtual.music_tag': null };
    } catch (error) {
      logProbe(`[TextTagManager] 扫描过程中发生错误: ${error}`, 'error');
      logProbe('', 'groupEnd');
      return { 'virtual.music_tag': null };
    }
  }

  const publicAPI = {
    getLatestState: _getLatestState,
  };

  logProbe('[TextTagManager] 模块初始化完成。');
  return publicAPI;
})();

// =================================================================
// 2. 状态管理器 (The State Manager) - [V2.0 重构版]
// =================================================================
const StateManager = (() => {
  logProbe('[StateManager] 模块正在初始化 (优先级队列内核)...');

  // -------------------
  // 2.1. 私有状态 (Private State)
  // -------------------
  // [重构] 核心数据结构变更为优先级队列
  let _activePlaylistQueue: QueueItem[] = [];
  let _lastActiveSwipeId: number | null = null;
  let _finishedBasePlaylists: Set<string> = new Set();
  let _playbackMode: PlaybackMode = 'list';
  let _masterVolume: number = 0.5;
  let _playbackState: 'STOPPED' | 'PLAYING' | 'PAUSED' = 'STOPPED';
  let _isPerformingEffect: boolean = false;

  // -------------------
  // 2.2. 私有核心算法 (Private Core Algorithms)
  // -------------------
  function _applyDepartureIsHistoryPrinciple(item: QueueItem, departingIndex: number) {
    if (typeof departingIndex !== 'number' || departingIndex < 0) return;
    item.playedIndices.add(departingIndex);
  }

  // -------------------
  // 2.3. 公共接口 (Public API)
  // -------------------
  const publicAPI = {
    // --- 基础状态查询 ---
    getPlaybackMode: () => _playbackMode,
    getVolume: () => _masterVolume,
    // [兼容性] 旧接口，仅当状态明确为 PLAYING 时返回 true
    isPlaying: () => _playbackState === 'PLAYING',
    getPlaybackState: () => _playbackState,
    isPerformingEffect: () => _isPerformingEffect,

    // --- [重构] 队列核心查询 ---
    /**
     * 获取当前优先级最高的歌单项（队首）。
     * 这是系统唯一的事实来源：当前应该播放什么。
     */
    getTopQueueItem: (): QueueItem | undefined => _.cloneDeep(_activePlaylistQueue[0]),

    /**
     * 获取整个队列的副本（用于调试或决策分析）。
     */
    getQueue: (): QueueItem[] => _.cloneDeep(_activePlaylistQueue),

    // --- 状态快照 ---
    getStateSnapshotForRuntime: () => {
      return _.cloneDeep({
        active_queue: _activePlaylistQueue,
        mode: _playbackMode,
        volume: _masterVolume,
        // [兼容性] 同时提供布尔值和枚举值
        isPlaying: _playbackState === 'PLAYING',
        playbackState: _playbackState,
        isPerformingEffect: _isPerformingEffect,
      });
    },

    getStateSnapshotForPersistence() {
      const runtimeQueue = _.cloneDeep(_activePlaylistQueue);

      const persistentQueue = runtimeQueue.map(item => {
        const persistedItem = _.omit(item, ['playbackPlan', 'planIndex', 'playlistContent']);

        return {
          ...persistedItem,
          // 将 Set 转换为 Array 以便 JSON 序列化
          playedIndices: Array.from(item.playedIndices),
        };
      });

      return {
        active_queue: persistentQueue,
        mode: _playbackMode,
        volume: _masterVolume,
        last_active_swipe_id: _lastActiveSwipeId,
        finished_base_playlists: Array.from(_finishedBasePlaylists),
      };
    },

    // --- 生命周期管理 ---
    resetState() {
      logProbe('[StateManager] 正在硬性重置所有状态...', 'warn');
      _activePlaylistQueue = [];
      _playbackMode = 'list';
      _masterVolume = 0.5;
      _playbackState = 'STOPPED';
      _isPerformingEffect = false;
      _lastActiveSwipeId = null;
      _finishedBasePlaylists.clear();
    },

    loadState(stateToLoad: any) {
      logProbe('[StateManager] 正在加载状态...', 'group');
      _playbackMode = stateToLoad.mode;
      _masterVolume = stateToLoad.volume;
      _activePlaylistQueue = stateToLoad.active_queue || [];
      _lastActiveSwipeId = stateToLoad.last_active_swipe_id ?? null;
      _finishedBasePlaylists = new Set(stateToLoad.finished_base_playlists || []);
      logProbe(
        `(探针) 记忆加载完成: 上次SwipeID=${_lastActiveSwipeId}, 已完结基础歌单数=${_finishedBasePlaylists.size}`,
      );
      logProbe(
        `状态加载完成. 队列深度: ${_activePlaylistQueue.length}, 模式: ${_playbackMode}, 音量: ${_masterVolume}`,
      );
      logProbe('', 'groupEnd');
    },

    // --- 基础状态设置 ---
    setPlaybackMode: (mode: PlaybackMode) => {
      _playbackMode = mode;
    },
    setVolume: (volume: number) => {
      _masterVolume = volume;
    },
    setPlaybackState: (newState: 'STOPPED' | 'PLAYING' | 'PAUSED') => {
      // [探针] 状态变更日志，帮助我们追踪每一次状态跳变
      if (_playbackState !== newState) {
        logProbe(`[StateManager] 状态流转: ${_playbackState} -> ${newState}`);
      }
      _playbackState = newState;
    },
    setPerformingEffect: (isPerforming: boolean) => {
      _isPerformingEffect = isPerforming;
    },

    getLastActiveSwipeId: () => _lastActiveSwipeId,
    setLastActiveSwipeId: (id: number | null) => {
      _lastActiveSwipeId = id;
    },

    getFinishedBasePlaylists: () => new Set(_finishedBasePlaylists),

    addToFinishedBasePlaylists: (playlistId: string) => {
      logProbe(`[StateManager]将基础歌单 "${playlistId}" 刻入已完成列表。`);
      _finishedBasePlaylists.add(playlistId);
    },

    clearFinishedBasePlaylists: () => {
      logProbe(`[StateManager]清空记录。`);
      _finishedBasePlaylists.clear();
    },

    // --- [重构] 队列核心操作 ---
    /**
     * [核心] 更新整个队列。
     * 此方法会自动按优先级降序排列队列，确保 _activePlaylistQueue[0] 永远是优先级最高的。
     */
    updateQueue(newQueue: QueueItem[]) {
      logProbe(`[StateManager] (Command) updateQueue: 正在更新并重排序队列 (共 ${newQueue.length} 项)...`);

      _activePlaylistQueue = _.cloneDeep(newQueue).sort((a, b) => b.priority - a.priority);

      if (_activePlaylistQueue.length > 0) {
        logProbe(
          `(探针) 新队首: "${_activePlaylistQueue[0].playlistId}" (优先级: ${_activePlaylistQueue[0].priority})`,
        );
      } else {
        logProbe(`(探针) 队列现已为空。`);
      }
    },

    // --- 当前项操作 (作用于队首) ---
    setCurrentIndex(index: number) {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) {
        _applyDepartureIsHistoryPrinciple(currentItem, currentItem.currentIndex);
        currentItem.currentIndex = index;
      }
    },

    commitNavigationStep(newTrackIndex: number) {
      const currentItem = _activePlaylistQueue[0];
      if (!currentItem) return;

      _applyDepartureIsHistoryPrinciple(currentItem, currentItem.currentIndex);

      if (_playbackMode === 'random' && currentItem.playbackPlan) {
        const newPlanIndex = currentItem.playbackPlan.indexOf(newTrackIndex);
        if (newPlanIndex !== -1) {
          currentItem.planIndex = newPlanIndex;
        }
      }
      currentItem.currentIndex = newTrackIndex;
    },

    clearHistoryForCurrentItem() {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) currentItem.playedIndices.clear();
    },

    resetCurrentItemForLoop() {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) {
        currentItem.playedIndices.clear();
        currentItem.currentIndex = 0;
      }
    },

    commitGenesisState(newCurrentIndex: number, newPlaybackPlan: number[], newPlanIndex: number) {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) {
        currentItem.currentIndex = newCurrentIndex;
        currentItem.playbackPlan = newPlaybackPlan;
        currentItem.planIndex = newPlanIndex;
      }
    },

    userInitiatedJump(trackIndex: number) {
      const currentItem = _activePlaylistQueue[0];
      if (!currentItem || trackIndex === currentItem.currentIndex) return;

      _applyDepartureIsHistoryPrinciple(currentItem, currentItem.currentIndex);
      currentItem.currentIndex = trackIndex;

      if (this.getPlaybackMode() === 'random' && currentItem.playbackPlan) {
        const newPlanIndex = currentItem.playbackPlan.indexOf(trackIndex);
        if (newPlanIndex !== -1) currentItem.planIndex = newPlanIndex;
      }
    },

    clearRandomModePlan() {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) {
        currentItem.playbackPlan = undefined;
        currentItem.planIndex = undefined;
      }
    },

    applyNewPlaybackPlan(plan: number[], planIndex: number) {
      const currentItem = _activePlaylistQueue[0];
      if (currentItem) {
        currentItem.playbackPlan = plan;
        currentItem.planIndex = planIndex;
      }
    },
  };

  logProbe('[StateManager] 模块初始化完成 (V2.0 内核)。');
  return publicAPI;
})();

// =================================================================
// 2.1. 播放引擎 (The Playback Engine)
// =================================================================
const PlaybackEngine = (() => {
  logProbe('[PlaybackEngine] 模块正在初始化...');
  let _playerA: HTMLAudioElement | null = null;
  let _playerB: HTMLAudioElement | null = null;
  let _activePlayer: HTMLAudioElement | null = null;
  let _standbyPlayer: HTMLAudioElement | null = null;
  let _fadeInterval: number | null = null;
  const FADE_DURATION = 400;

  // --- 私有函数 ---
  function _swapPlayers() {
    [_activePlayer, _standbyPlayer] = [_standbyPlayer, _activePlayer];
  }

  function _fadeVolumeAsync(player: HTMLAudioElement | null, targetVolume: number, duration: number): Promise<void> {
    return new Promise(resolve => {
      if (_fadeInterval) {
        clearInterval(_fadeInterval);
        _fadeInterval = null;
      }

      if (!player) return resolve();

      const startVolume = player.volume;
      const stepTime = 50;
      const steps = duration / stepTime;
      if (steps <= 0) {
        player.volume = targetVolume;
        return resolve();
      }
      const volumeStep = (targetVolume - startVolume) / steps;
      let currentStep = 0;

      _fadeInterval = window.setInterval(() => {
        currentStep++;
        if (currentStep >= steps) {
          if (_fadeInterval) clearInterval(_fadeInterval);
          _fadeInterval = null;
          player.volume = targetVolume;
          resolve();
        } else {
          player.volume += volumeStep;
        }
      }, stepTime);
    });
  }

  // --- 公共接口 ---
  const publicAPI = {
    initialize() {
      if (_playerA && _playerB) return;
      logProbe('[Engine] 正在创建和配置 HTML5 Audio 元素...');
      const createPlayer = (): HTMLAudioElement => {
        const audio = new Audio();
        audio.preload = 'auto';
        audio.crossOrigin = 'anonymous';
        audio.addEventListener('ended', () => {
          if (audio === _activePlayer) void _handleTrackEnded();
        });
        audio.addEventListener('error', () => {
          /* 错误由 Promise reject 处理 */
        });
        audio.addEventListener('timeupdate', broadcastTimeUpdate);
        return audio;
      };
      _playerA = createPlayer();
      _playerB = createPlayer();
      _activePlayer = _playerA;
      _standbyPlayer = _playerB;
      logProbe('[Engine] Audio 元素已就绪。');
    },

    getActivePlayer: () => _activePlayer,
    getStandbyPlayer: () => _standbyPlayer,

    async transitionToTrack(targetTrackUrl: string, targetVolume: number): Promise<void> {
      logProbe(`[Engine] 收到过渡请求: URL=${targetTrackUrl.slice(0, 50)}...`, 'group');

      if (!_standbyPlayer || !_activePlayer) {
        logProbe('[Engine] 过渡中止：播放器实例尚未初始化。', 'error');
        logProbe('', 'groupEnd');
        throw new Error('播放器实例尚未初始化');
      }

      const standbyPlayer = _standbyPlayer;
      const activePlayer = _activePlayer;

      standbyPlayer.src = targetTrackUrl;
      standbyPlayer.load();

      try {
        await new Promise<void>((resolve, reject) => {
          const onCanPlay = () => {
            standbyPlayer.removeEventListener('canplaythrough', onCanPlay);
            standbyPlayer.removeEventListener('error', onError);
            logProbe('[Engine] 备用播放器加载成功 (canplaythrough)。', 'log');
            resolve();
          };

          const onError = (e: Event) => {
            standbyPlayer.removeEventListener('canplaythrough', onCanPlay);
            standbyPlayer.removeEventListener('error', onError);
            logProbe(`[Engine] 备用播放器加载失败!`, 'error');
            const target = e.target as HTMLAudioElement;
            const error = target.error;
            reject(new Error(`音频加载失败: ${error?.message || '未知错误'}`));
          };
          standbyPlayer.addEventListener('canplaythrough', onCanPlay);
          standbyPlayer.addEventListener('error', onError);
        });
      } catch (error) {
        logProbe('[Engine] 过渡因加载失败而中止。', 'groupEnd');
        throw error;
      }

      await _fadeVolumeAsync(activePlayer, 0, 500);
      activePlayer.pause();

      _swapPlayers();

      const newActivePlayer = this.getActivePlayer();
      if (!newActivePlayer) throw new Error('播放器实例在交换后丢失');

      const playPromise = newActivePlayer.play();
      if (playPromise) {
        await playPromise;
      }
      await _fadeVolumeAsync(newActivePlayer, targetVolume, 500);

      logProbe('[Engine] 过渡成功完成。', 'groupEnd');
    },

    async fadeOutAndPause(): Promise<void> {
      logProbe('[Engine] 命令: FadeOutAndPause');
      await _fadeVolumeAsync(_activePlayer, 0, FADE_DURATION);
      _activePlayer?.pause();
    },

    async executeHardCut(targetTrackUrl: string, targetVolume: number): Promise<void> {
      logProbe(`[Engine:HardCut] 收到“瞬击”请求: URL=${targetTrackUrl.slice(0, 50)}...`, 'group');
      const activePlayer = this.getActivePlayer();
      if (!activePlayer) {
        logProbe('[Engine:HardCut] 致命错误：无可用播放器实例。', 'error');
        logProbe('', 'groupEnd');
        throw new Error('No active player available for hard cut.');
      }

      logProbe(`(探针) 切换前 src: ${activePlayer.src.slice(-50)}`);

      activePlayer.pause();
      activePlayer.src = targetTrackUrl;
      activePlayer.volume = targetVolume;

      logProbe(`(探针) 切换后 src: ${activePlayer.src.slice(-50)}`);

      try {
        const playPromise = activePlayer.play();
        if (playPromise) {
          await playPromise;
        }

        StateManager.setPlaybackState('PLAYING');
        logProbe('[Engine:HardCut] “瞬击”播放成功。');
      } catch (error) {
        logProbe(`[Engine:HardCut] “瞬击”播放失败! 这通常是因为用户未与页面交互。`, 'error');

        StateManager.setPlaybackState('STOPPED');

        throw error;
      } finally {
        logProbe('', 'groupEnd');
      }
    },

    async resumeAndFadeIn(targetVolume: number): Promise<void> {
      logProbe('[Engine] 命令: ResumeAndFadeIn');
      const playPromise = _activePlayer?.play();
      if (playPromise) await playPromise;
      await _fadeVolumeAsync(_activePlayer, targetVolume, FADE_DURATION);
    },
  };

  logProbe('[PlaybackEngine] 模块初始化完成。');
  return publicAPI;
})();

// =================================================================
// 2.2. 播放策略实现 (Playback Strategies)
// =================================================================

class ListStrategy implements IPlaybackStrategy {
  public onQueueChanged(_currentItem: QueueItem | undefined): void {}

  public advance(currentItem: QueueItem, direction: 'next' | 'prev'): StrategyDecision {
    logProbe(
      `[Strategy:List] 收到 advance 请求. 方向: ${direction}, 当前: { playlistId: "${currentItem.playlistId}", index: ${currentItem.currentIndex}, rule: "${currentItem.onFinishRule}" }`,
    );

    if (direction === 'next') {
      logProbe('[Strategy:List] 决策: advance(next) -> 委托给 onTrackEnd');
      return this.onTrackEnd(currentItem);
    }

    const { currentIndex, onFinishRule, playlistContent } = currentItem;
    const totalTracks = playlistContent.length;

    if (currentIndex > 0) {
      const nextIndex = currentIndex - 1;
      logProbe(`[Strategy:List] 决策: advance(prev) -> GoTo (index: ${nextIndex})`);
      return { action: 'GoTo', nextIndex };
    } else if (onFinishRule === 'loop') {
      const lastIndex = totalTracks > 0 ? totalTracks - 1 : 0;
      logProbe(`[Strategy:List] 决策: advance(prev) at start -> Loop to end (index: ${lastIndex})`);
      return { action: 'GoTo', nextIndex: lastIndex };
    } else {
      logProbe('[Strategy:List] 决策: advance(prev) at start -> Restart');
      return { action: 'Restart' };
    }
  }

  public onTrackEnd(currentItem: QueueItem): StrategyDecision {
    logProbe(
      `[Strategy:List] 收到 onTrackEnd 请求. 当前: { playlistId: "${currentItem.playlistId}", index: ${currentItem.currentIndex}, rule: "${currentItem.onFinishRule}" }`,
    );

    const { currentIndex, onFinishRule, playlistContent, playedIndices } = currentItem;
    const totalTracks = playlistContent.length;
    const nextIndex = currentIndex + 1;

    if (nextIndex < totalTracks) {
      logProbe(`[Strategy:List] 决策: onTrackEnd -> GoTo (index: ${nextIndex})`);
      return { action: 'GoTo', nextIndex };
    } else if (onFinishRule === 'pop') {
      logProbe('[Strategy:List] 决策: onTrackEnd at end -> PopStack');
      return { action: 'RemoveTopAndAdvance' };
    } else {
      const totalValidTracks = playlistContent.length;
      const historySizeAfterThisTrack = playedIndices.size + 1;

      if (historySizeAfterThisTrack >= totalValidTracks) {
        logProbe(`[Strategy:List] 决策: onTrackEnd at end -> LoopReset (一个完整的循环已结束)`, 'warn');
        return { action: 'LoopReset' };
      } else {
        logProbe(`[Strategy:List] 决策: onTrackEnd at end -> GoTo (普通循环，继续播放未听过的歌曲)`);
        return { action: 'GoTo', nextIndex: 0 };
      }
    }
  }

  public onPlaybackError(currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:List] 收到 onPlaybackError 请求。决策: 委托给 advance('next')`);
    return this.advance(currentItem, 'next');
  }
}

class SingleStrategy implements IPlaybackStrategy {
  public onQueueChanged(_currentItem: QueueItem | undefined): void {}

  public advance(_currentItem: QueueItem, direction: 'next' | 'prev'): StrategyDecision {
    logProbe(`[Strategy:Single] 收到 advance 请求. 方向: ${direction}. 决策: Restart`);
    return { action: 'Restart' };
  }

  public onTrackEnd(_currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:Single] 收到 onTrackEnd 请求. 决策: Restart`);
    return { action: 'Restart' };
  }

  public onPlaybackError(_currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:Single] 收到 onPlaybackError 请求。决策: Stop (单曲循环下无法自动前进)`);
    return { action: 'Stop' };
  }
}

class RandomStrategy implements IPlaybackStrategy {
  private _generateIntelligentShuffle(
    allTrackIndices: number[],
    playedIndices: Set<number>,
    currentIndex: number,
  ): number[] {
    logProbe(`[Strategy:Random] (Algo) _generateIntelligentShuffle 执行...`, 'groupCollapsed');
    logProbe(
      `输入: allIndices.length=${allTrackIndices.length}, playedIndices.size=${playedIndices.size}, currentIndex=${currentIndex}`,
    );

    const sourceForShuffle = allTrackIndices.filter(i => !playedIndices.has(i) && i !== currentIndex);
    logProbe(`计算待选池 (sourceForShuffle) 大小: ${sourceForShuffle.length}`);

    for (let i = sourceForShuffle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sourceForShuffle[i], sourceForShuffle[j]] = [sourceForShuffle[j], sourceForShuffle[i]];
    }

    logProbe(`洗牌完成. 输出 shuffledIndices (纯粹的未来队列): [${sourceForShuffle.join(', ')}]`);
    logProbe('', 'groupEnd');
    return sourceForShuffle;
  }

  private _generatePlaybackPlan(
    playedIndices: Set<number>,
    currentIndex: number,
    shuffledIndices: number[],
  ): { playbackPlan: number[]; planIndex: number } {
    logProbe(`[Strategy:Random] (Algo) _generatePlaybackPlan 执行...`, 'groupCollapsed');
    logProbe(
      `输入: playedIndices.size=${playedIndices.size}, currentIndex=${currentIndex}, shuffledIndices.length=${shuffledIndices.length}`,
    );

    const knownSequence = Array.from(new Set([...playedIndices, currentIndex]));
    const planIndex = knownSequence.indexOf(currentIndex);
    const playbackPlan = [...knownSequence, ...shuffledIndices];

    logProbe(`(守护者探针) "已知序列" (unique history + current): [${knownSequence.join(', ')}]`);
    logProbe(`生成导航地图 (playbackPlan): [${playbackPlan.join(', ')}]`);
    logProbe(`定位导航指针 (planIndex): ${planIndex}`);
    logProbe('', 'groupEnd');

    return { playbackPlan, planIndex };
  }

  private _handlePlanEnd(currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:Random] (Helper) _handlePlanEnd: 已到达计划终点，开始进行边界决策...`, 'groupCollapsed');
    logProbe(`(探针) 待决策歌单: "${currentItem.playlistId}", 结束规则: "${currentItem.onFinishRule}"`);

    if (currentItem.onFinishRule === 'pop') {
      logProbe(`(边界决策) onFinishRule 为 'pop'，决策 -> PopStack`);
      logProbe('', 'groupEnd');
      return { action: 'RemoveTopAndAdvance' };
    } else {
      logProbe(`(边界决策) onFinishRule 为 'loop'，决策 -> LoopReset`);
      logProbe('', 'groupEnd');
      return { action: 'LoopReset' };
    }
  }

  public onQueueChanged(currentItem: QueueItem | undefined): void {
    if (!currentItem) {
      logProbe('[Strategy:Random] onQueueChanged 中止：无有效的当前项。');
      return;
    }

    logProbe(
      `[Strategy:Random] onQueueChanged 已触发 (连续性恢复)，将为歌单 "${currentItem.playlistId}" 生成播放计划...`,
    );

    const allIndices = currentItem.playlistContent.map((_, i) => i);
    const shuffled = this._generateIntelligentShuffle(allIndices, currentItem.playedIndices, currentItem.currentIndex);
    const { playbackPlan, planIndex } = this._generatePlaybackPlan(
      currentItem.playedIndices,
      currentItem.currentIndex,
      shuffled,
    );

    StateManager.applyNewPlaybackPlan(playbackPlan, planIndex);
  }

  public prepareGenesis(currentItem: QueueItem | undefined): {
    newCurrentIndex: number;
    newPlaybackPlan: number[];
    newPlanIndex: number;
  } | null {
    if (!currentItem || !currentItem.playlistContent) {
      logProbe('[Strategy:Random] prepareGenesis 中止：传入的队列项无效。', 'error');
      return null;
    }

    logProbe('[Strategy:Random] (Query) prepareGenesis: 收到“创世乐谱”谱写请求...', 'group');

    const allIndices = currentItem.playlistContent.map((_, i) => i);
    for (let i = allIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allIndices[i], allIndices[j]] = [allIndices[j], allIndices[i]];
    }

    const newPlaybackPlan = allIndices;
    const newPlanIndex = 0;
    const newCurrentIndex = newPlaybackPlan[newPlanIndex];

    logProbe(`(乐谱) 谱写完成。New CurrentIndex: ${newCurrentIndex}, New PlanIndex: ${newPlanIndex}`);
    logProbe('', 'groupEnd');

    return { newCurrentIndex, newPlaybackPlan, newPlanIndex };
  }

  public advance(currentItem: QueueItem, direction: 'next' | 'prev'): StrategyDecision {
    logProbe(`[Strategy:Random] 收到 advance 请求. 方向: ${direction}`, 'groupCollapsed');

    const { playbackPlan, planIndex } = currentItem;

    if (!playbackPlan || planIndex === undefined) {
      logProbe('[Strategy:Random] 决策中止：导航计划 (playbackPlan) 尚未初始化。', 'error');
      logProbe('', 'groupEnd');
      return { action: 'DoNothing' };
    }

    logProbe(`(探针) 当前导航指针 (planIndex): ${planIndex}`);
    logProbe(`(探针) 导航地图 (playbackPlan): [${playbackPlan.join(', ')}]`);

    if (direction === 'next') {
      const nextPlanIndex = planIndex + 1;

      if (nextPlanIndex < playbackPlan.length) {
        const targetTrackIndex = playbackPlan[nextPlanIndex];
        logProbe(
          `[Strategy:Random] 决策: advance(next) -> GoTo (新 planIndex: ${nextPlanIndex}, 目标 trackIndex: ${targetTrackIndex})`,
        );
        logProbe('', 'groupEnd');
        return { action: 'GoTo', nextIndex: targetTrackIndex };
      } else {
        logProbe('[Strategy:Random] advance(next) 已到达计划终点，委托给 _handlePlanEnd...');
        logProbe('', 'groupEnd');
        return this._handlePlanEnd(currentItem);
      }
    } else {
      // direction === 'prev'
      const prevPlanIndex = planIndex - 1;

      if (prevPlanIndex >= 0) {
        const targetTrackIndex = playbackPlan[prevPlanIndex];
        logProbe(
          `[Strategy:Random] 决策: advance(prev) -> GoTo (新 planIndex: ${prevPlanIndex}, 目标 trackIndex: ${targetTrackIndex})`,
        );
        logProbe('', 'groupEnd');
        return { action: 'GoTo', nextIndex: targetTrackIndex };
      } else {
        logProbe(`[Strategy:Random] 决策: advance(prev) 已在计划起点。返回 DoNothing。`);
        logProbe('', 'groupEnd');
        return { action: 'DoNothing' };
      }
    }
  }

  public onTrackEnd(currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:Random] 收到 onTrackEnd 请求.`, 'groupCollapsed');

    const { playbackPlan, planIndex } = currentItem;

    if (!playbackPlan || planIndex === undefined) {
      logProbe('[Strategy:Random] 决策中止：导航计划 (playbackPlan) 尚未初始化。返回 Stop 以策安全。', 'error');
      logProbe('', 'groupEnd');
      return { action: 'Stop' };
    }

    logProbe(`(探针) 当前导航指针 (planIndex): ${planIndex}`);
    logProbe(`(探针) 导航地图 (playbackPlan): [${playbackPlan.join(', ')}]`);

    const nextPlanIndex = planIndex + 1;

    if (nextPlanIndex < playbackPlan.length) {
      const targetTrackIndex = playbackPlan[nextPlanIndex];
      logProbe(
        `[Strategy:Random] 决策: onTrackEnd -> GoTo (新 planIndex: ${nextPlanIndex}, 目标 trackIndex: ${targetTrackIndex})`,
      );
      logProbe('', 'groupEnd');
      return { action: 'GoTo', nextIndex: targetTrackIndex };
    } else {
      logProbe('[Strategy:Random] onTrackEnd 已到达计划终点，委托给 _handlePlanEnd...');
      logProbe('', 'groupEnd');
      return this._handlePlanEnd(currentItem);
    }
  }

  public onPlaybackError(currentItem: QueueItem): StrategyDecision {
    logProbe(`[Strategy:Random] 收到 onPlaybackError 请求。决策: 委托给 advance('next')`);
    return this.advance(currentItem, 'next');
  }
}

// =================================================================
// 2.3. 策略管理器 (The StrategyManager - "The Conductor")
// =================================================================
const StrategyManager = (() => {
  logProbe('[StrategyManager] 模块正在初始化...');

  const _strategies: Record<PlaybackMode, IPlaybackStrategy> = {
    list: new ListStrategy(),
    single: new SingleStrategy(),
    random: new RandomStrategy(),
  };
  let _currentStrategy: IPlaybackStrategy = _strategies.list;

  const publicAPI = {
    /**
     * [命令] 设置新的播放模式，并自动切换到对应的策略实例。
     */
    setMode(mode: PlaybackMode) {
      logProbe(`[StrategyManager] (Command) setMode: 切换策略模式为 -> ${mode}`);
      _currentStrategy = _strategies[mode];
    },

    /**
     * [查询] 获取当前激活的策略实例。这是我们遵循CQS原则的体现。
     */
    getCurrentStrategy: () => _currentStrategy,

    /**
     * [命令] 通知当前策略：核心状态（如队列）已发生重大变化。
     * 这是修复BUG的核心，它为策略提供了一个统一的生命周期钩子。
     */

    notifyQueueChanged() {
      logProbe(
        `[StrategyManager] (Command) notifyQueueChanged: 正在通知当前策略 (${_currentStrategy.constructor.name}) 队列已变更...`,
        'groupCollapsed',
      );
      const currentItem = StateManager.getTopQueueItem();
      _currentStrategy.onQueueChanged(currentItem);
      logProbe('[StrategyManager] 通知完成。', 'groupEnd');
    },
  };

  logProbe('[StrategyManager] 模块初始化完成。');
  return publicAPI;
})();

// =================================================================
// 3. 全局变量与常量 (Global Variables & Constants)
// =================================================================

const STATE_KEY = '余烬双星_播放器状态';

let isInitializedForThisChat = false;
let isReconciling = false;
let _initializationPromiseControls: { resolve: () => void; reject: (reason?: any) => void } | null = null;

let _initializationPromise: Promise<void> | null = null;
let isScriptActive = true;
let allPlaylists: Record<string, PlaylistConfig> = {};
let triggers: z.infer<typeof ZodTriggerConfig>[] = [];
let defaultPlaylistId: string | undefined = '';

let isMvuIntegrationActive = false;
let isCorePlayerInitialized = false;
let isMvuMode = true;
let _currentChatId: string | number | null = null;

const fullStateUpdateCallbacks: ((payload: FullStatePayload) => void)[] = [];
const timeUpdateCallbacks: ((payload: TimeUpdatePayload) => void)[] = [];

/**
 * [V9.5 统一校准官] 新架构的“运行时大脑”。
 * 它的单一职责是：响应“运行时”的增量事件，通过“边沿检测”模型，
 * 精确地、最小化地修改当前队列，并决策是否需要变更播放。
 * @param eventPayload - 可选的、来自 MVU 事件的最新状态数据。
 */
async function _reconcilePlaylistQueue(eventPayload?: any, options?: { transitionEffect?: 'hard' | 'smooth' }) {
  if (!isScriptActive) {
    return;
  }
  // --- 1. 【前置检查】: 防止并发的事件风暴 ---
  if (isReconciling) {
    logProbe('[Reconciler] 请求被合并：前一个校准任务仍在进行中。', 'warn');
    return;
  }
  isReconciling = true;
  logProbe(`=== [Reconciler] “统一校准官”已接管运行时事件 (模式: ${isMvuMode ? 'MVU' : 'Text'}) ===`, 'group');

  try {
    StateManager.setPerformingEffect(true);
    logProbe('[Reconciler] (事务) 已上效果锁并广播“过渡中”状态，UI应进入等待。');
    broadcastFullState();

    // --- 核心逻辑 ---
    try {
      const oldTopItem = StateManager.getTopQueueItem();

      // --- 2. 【获取事实 (The Branch)】: 双轨制分流 ---
      let currentStateData: Record<string, any> = {};

      if (isMvuMode) {
        // [路径 A: MVU 模式]
        if (eventPayload?.stat_data) {
          // Case 1: 事件推送 (VARIABLE_UPDATE_ENDED)
          currentStateData = eventPayload.stat_data;
          logProbe('[Reconciler] (事实) 采用事件载荷提供的 MVU 状态。');
        } else {
          // Case 2: 主动查询 (MESSAGE_SWIPED / MESSAGE_DELETED)
          // 注意：由于我们在事件监听层已经通过 duringGenerating() 过滤了生成中的情况，
          // 这里获取到的权威状态应该是稳定且可靠的。
          const authState = await _findLatestAuthoritativeMvuState();

          if (authState) {
            currentStateData = authState.mvuData?.stat_data ?? {};
            logProbe('[Reconciler] (事实) 主动查询并采用了最新的 MVU 状态。');
          } else {
            // 如果真的找不到任何数据（极罕见），默认为空状态，这意味着触发器可能全部失效
            logProbe('[Reconciler] (事实) 未找到有效的 MVU 状态，将使用空状态进行校准。', 'warn');
            currentStateData = {};
          }
        }
      } else {
        // [路径 B: Text 模式]
        logProbe('[Reconciler] (事实) 进入 Text 模式状态获取流程...');
        currentStateData = await TextTagManager.getLatestState();
        logProbe('[Reconciler] (事实) TextTagManager 已返回标准化状态。');
      }

      // --- 3. 【生成报告】: 委托 MvuManager 进行边沿检测 ---
      const previousStateData = MvuManager.getPreviousState();
      const changeReport = MvuManager.calculateChangeReport(previousStateData, currentStateData, triggers);

      // --- 4. 【执行队列的增量修改】: 先减后加 ---
      const newQueue = StateManager.getQueue();

      if (changeReport.newlyInactiveTriggers.length > 0) {
        _.remove(newQueue, item =>
          changeReport.newlyInactiveTriggers.some(inactiveTrigger =>
            areTriggersFunctionallyEqual(item.triggerSource, inactiveTrigger),
          ),
        );
        logProbe(`[Reconciler] (修改) 根据报告移除了 ${changeReport.newlyInactiveTriggers.length} 个失效项。`);
      }

      if (changeReport.newlyActiveTriggers.length > 0) {
        for (const activeTrigger of changeReport.newlyActiveTriggers) {
          if (
            newQueue.some(item => item.triggerSource && areTriggersFunctionallyEqual(item.triggerSource, activeTrigger))
          ) {
            logProbe(`[Reconciler] (防御) 拒绝添加重复的激活项: "${activeTrigger.playlist_id}"`, 'warn');
            continue;
          }
          const newItem = createQueueItem({
            type: 'mvu',
            playlistId: activeTrigger.playlist_id,
            trigger: activeTrigger,
          });
          if (newItem) {
            newQueue.push(newItem);
            logProbe(`[Reconciler] (修改) 根据报告添加了新激活项: "${newItem.playlistId}"`);
          }
        }
      }

      StateManager.updateQueue(newQueue);

      // --- 5. 【决策与执行】: 对比新旧队首 ---
      const newTopItem = StateManager.getTopQueueItem();

      if (newTopItem?.playlistId !== oldTopItem?.playlistId) {
        logProbe(
          `[Reconciler] (决策) 队首发生变更！ 从 "${oldTopItem?.playlistId ?? '无'}" 变为 "${newTopItem?.playlistId ?? '无'}"。`,
        );

        if (newTopItem) {
          logProbe('[Reconciler] (握手) 正在通知 StrategyManager 队列已变更...');
          StrategyManager.notifyQueueChanged();

          newTopItem.wasEverPlayed = true;
          const targetIndex = newTopItem.wasEverPlayed ? newTopItem.currentIndex : 0;

          if (StateManager.isPlaying()) {
            logProbe('[Reconciler] (效果) 用户正在播放，将执行过渡效果...');
            if (options?.transitionEffect === 'hard') {
              await PlaybackEngine.executeHardCut(
                newTopItem.playlistContent[targetIndex].url,
                StateManager.getVolume(),
              );
            } else {
              await _executeTransition(targetIndex);
            }
          } else if (
            oldTopItem === undefined && // 1. 队列发生“从无到有”的跃迁
            StateManager.getPlaybackState() === 'STOPPED' // 2. 关键：只要不是 PAUSED (用户主动暂停)，就允许场景触发播放
          ) {
            logProbe(
              '[Reconciler] 自动播放契约满足 (Queue 0->1 + Not Paused)，将调用 _executeGenesisPlayInternal。',
              'warn',
            );
            await _executeGenesisPlayInternal(targetIndex);
          } else {
            logProbe('[Reconciler] (效果) 用户已暂停或未授权，仅在后台静默更新轨道，不播放。');
            const track = newTopItem.playlistContent[targetIndex];
            const activePlayer = PlaybackEngine.getActivePlayer();
            if (track && activePlayer) {
              activePlayer.src = track.url;
            }
          }
        } else {
          logProbe('[Reconciler] (决策) 监测到队列已完全清空。正在执行“物理静音”协议...', 'warn');

          await PlaybackEngine.fadeOutAndPause();

          StateManager.setPlaybackState('STOPPED');

          StrategyManager.notifyQueueChanged();

          logProbe('[Reconciler] (执行) “物理静音”完成，播放状态已置为 STOPPED。');
        }
      } else {
        logProbe('[Reconciler] (决策) 队首未发生变更，保持当前播放稳定。');
      }

      // --- 6. 【更新记忆】: 为下一次边沿检测做准备 ---
      await MvuManager.persistCurrentState(currentStateData);
    } catch (error) {
      logProbe(`[Reconciler] 核心逻辑执行期间发生严重错误: ${error}`, 'error');
      console.error(error);
    } finally {
      await writeState('reconciliation');
    }
  } finally {
    isReconciling = false;
    await _releaseEffectLock();
    logProbe('=== [Reconciler] “统一校准官”任务完成 (锁已通过调度器释放) ===', 'groupEnd');
  }
}

// =================================================================
// 4. 核心工具与广播系统 (Core Utilities & Broadcast System)
// =================================================================

function broadcastFullState() {
  const currentItem = StateManager.getTopQueueItem();
  const currentPlaylist = currentItem?.playlistContent ?? [];
  const currentIndex = currentItem?.currentIndex ?? 0;

  const payload: FullStatePayload = {
    currentItem: currentPlaylist[currentIndex]
      ? {
          title: currentPlaylist[currentIndex].歌名,
          artist: currentPlaylist[currentIndex].歌手,
          cover: currentPlaylist[currentIndex].封面,
        }
      : null,
    isPlaying: StateManager.isPlaying(),
    playbackState: StateManager.getPlaybackState(),
    playbackMode: StateManager.getPlaybackMode(),
    masterVolume: StateManager.getVolume(),
    playlist: currentPlaylist.map(item => ({ title: item.歌名, artist: item.歌手, cover: item.封面 })),
    isTransitioning: StateManager.isPerformingEffect(),
  };
  logProbe(
    `[Broadcast] 正在广播完整状态... [旧兼容: isPlaying=${payload.isPlaying}] [新内核: state=${payload.playbackState}] mode: ${payload.playbackMode}, currentItem: ${payload.currentItem?.title ?? '无'}`,
    'groupCollapsed',
  );
  logProbe(`详细: isTransitioning=${payload.isTransitioning}`);
  logProbe('', 'groupEnd');

  fullStateUpdateCallbacks.forEach(callback => {
    try {
      callback(payload);
    } catch (e) {
      console.error('[音乐脚本] 完整状态回调执行出错:', e);
    }
  });
}

function broadcastTimeUpdate() {
  const activePlayer = PlaybackEngine.getActivePlayer();
  if (!StateManager.isPlaying() || !activePlayer) return;
  const payload: TimeUpdatePayload = {
    currentTime: activePlayer.currentTime,
    duration: activePlayer.duration || 0,
  };
  timeUpdateCallbacks.forEach(callback => callback(payload));
}

function prepareNextTrack() {
  const currentItem = StateManager.getTopQueueItem();
  const standbyPlayer = PlaybackEngine.getStandbyPlayer();
  if (!standbyPlayer || !currentItem) return;
  const nextIndex = currentItem.currentIndex + 1;
  if (nextIndex < currentItem.playlistContent.length) {
    const nextTrack = currentItem.playlistContent[nextIndex];
    if (nextTrack && standbyPlayer.src !== nextTrack.url) {
      standbyPlayer.src = nextTrack.url;
      standbyPlayer.load();
    }
  }
}

// =================================================================
// 5. 状态管理 (State Management)
// =================================================================

function readState() {
  logProbe('[StateReader] 正在尝试从酒馆变量读取持久化状态...');
  const savedData = getVariables({ type: 'chat' })[STATE_KEY];

  if (!savedData || typeof savedData !== 'object') {
    logProbe('[StateReader] 未发现有效存档。');
    return null;
  }

  logProbe('[StateReader] 发现原始状态数据，正在提交给 Zod 进行安全验证...');
  const validationResult = ZodPersistedState.safeParse(savedData);

  if (validationResult.success) {
    logProbe('[StateReader] Zod 验证成功，状态数据安全。');
    return validationResult.data;
  } else {
    console.warn('[StateReader] 持久化状态验证失败:', validationResult.error);
    return null;
  }
}

async function writeState(source: string) {
  if (!isScriptActive) {
    logProbe(`[State] 写入操作被阻止，因为脚本正在停机。(来源: ${source})`, 'warn');
    return;
  }
  try {
    logProbe(`[State] 由 "${source}" 触发状态写入...`);
    const dataToSave = StateManager.getStateSnapshotForPersistence();

    await updateVariablesWith(
      vars => {
        vars[STATE_KEY] = dataToSave;
        return vars;
      },
      { type: 'chat' },
    );

    logProbe(`[State] 状态已成功写入酒馆变量`);
  } catch (e: any) {
    logProbe(`[State] 写入状态时发生严重错误: ${e}`, 'error');
  }
}

// =================================================================
// 6. 世界书配置解析与队列操作 (Worldbook Parsing & Stack Operations)
// =================================================================

/**
 * @description 格式化 Zod 验证错误，以便在 toastr 中为角色卡作者显示清晰、可操作的反馈。
 */
function _formatZodErrorForToastr(error: ZodError): void {
  const issue = error.issues[0];
  const path = issue.path.join(' -> ');
  const message = issue.message;

  const toastrTitle = `[MusicConfig] 内容错误`;
  const toastrMessage = `路径: ${path} | 问题: ${message}`;

  const fullLogMessage = `[MusicConfig] 内容错误:\n路径: ${path}\n问题: ${message}`;
  logProbe(`[ZodValidator] 世界书配置验证失败: ${fullLogMessage}`, 'error');

  toastr.error(toastrMessage, toastrTitle, { timeOut: 15000 });
}

// =================================================================
// 核心算法 V9.5 (Core Algorithms for "Concerto")
// 原则: 这些函数都必须是纯粹的查询 (CQS)，严禁产生任何副作用。
// =================================================================

/**
 * [核心算法] 判断两个触发器对象是否代表同一个“功能身份”。
 * @param a - 第一个触发器对象。
 * @param b - 第二个触发器对象。
 * @returns {boolean} 如果功能上相等，则返回 true。
 */
function areTriggersFunctionallyEqual(
  a: z.infer<typeof ZodTriggerConfig> | undefined,
  b: z.infer<typeof ZodTriggerConfig> | undefined,
): boolean {
  if (!a || !b) return a === b;

  if (a.playlist_id !== b.playlist_id) return false;

  type ConditionKey = keyof z.infer<typeof ZodSingleCondition>;

  const getCanonicalString = (condition: z.infer<typeof ZodSingleCondition>): string => {
    return (Object.keys(condition) as ConditionKey[])
      .sort()
      .map(key => `${key}:${String(condition[key])}`) // 使用 String() 来确保所有值都能被正确处理
      .join(',');
  };

  const conditionsA = a.conditions.map(getCanonicalString).sort();
  const conditionsB = b.conditions.map(getCanonicalString).sort();

  return conditionsA.length === conditionsB.length && conditionsA.every((val, index) => val === conditionsB[index]);
}

/**
 * @description [V9.7 核心强化] 查找权威MVU状态。现在能够识别“创世”和“运行时”两种数据结构。
 * @param context - 可选的上下文，用于指导查找方式。
 * @returns {Promise<{ mvuData: any, messageId: number } | null>} 权威状态或 null。
 */
async function _findLatestAuthoritativeMvuState(context?: {
  messageId: number;
  swipeId: number;
}): Promise<{ mvuData: any; messageId: number } | null> {
  // --- 模式一: 精确制导 (通常用于开场白) ---
  if (context && context.messageId === 0 && typeof context.swipeId === 'number') {
    logProbe(
      `[StateFinder] (精确制导模式) 目标: message_id=${context.messageId}, swipe_id=${context.swipeId}`,
      'groupCollapsed',
    );
    try {
      const mvuDataContainer: any = await Mvu.getMvuData({ type: 'message', message_id: 0 });

      const swipeSpecificData = mvuDataContainer?.swipes_data?.[context.swipeId];

      if (swipeSpecificData?.stat_data) {
        // 成功在 "创世" 结构中找到特定 swipe 的数据
        logProbe('[StateFinder] (探针) 检测到“创世”结构 (swipes_data)，成功命中！');
        logProbe('', 'groupEnd');
        return { mvuData: swipeSpecificData, messageId: 0 };
      } else if (mvuDataContainer?.stat_data) {
        // 在顶层找到了 "运行时" 结构的数据 (可能只有一个开场白)
        logProbe('[StateFinder] (探针) 检测到“运行时”结构 (顶层 stat_data)，直接采用。');
        logProbe('', 'groupEnd');
        return { mvuData: mvuDataContainer, messageId: 0 };
      } else {
        logProbe('[StateFinder] (精确制导模式) 查找失败：在两种已知结构中均未找到 stat_data。', 'warn');
      }
    } catch (error) {
      logProbe(`[StateFinder] (精确制导模式) 查询时出错: ${error}`, 'error');
    } finally {
      logProbe('', 'groupEnd');
    }
  }

  // --- 模式二: 回溯扫描 (找不到精确目标时的标准流程) ---
  logProbe('[StateFinder] (回溯扫描模式) 开始执行...', 'groupCollapsed');
  try {
    const allMessages = getChatMessages(-1, { include_swipes: true });
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const message = allMessages[i];
      // [V9.7 核心修正] 修复致命拼写错误：message.id -> message.message_id
      const currentMessageId = message.message_id;

      // 防御性编程：如果 message_id 无效，直接跳过，防止意外
      if (typeof currentMessageId !== 'number') {
        logProbe(`(探针) 跳过无效楼层 (索引 ${i})，因其 message_id 为 ${currentMessageId}。`, 'warn');
        continue;
      }

      try {
        logProbe(`(探针) 正在查询 message_id: ${currentMessageId}...`);
        const mvuData = await Mvu.getMvuData({ type: 'message', message_id: currentMessageId });

        if (mvuData?.stat_data) {
          logProbe(`[StateFinder] 查找成功！在 message_id: ${currentMessageId} 处找到权威状态。`);
          logProbe('', 'groupEnd');
          return { mvuData, messageId: currentMessageId };
        }
      } catch (error) {
        logProbe(`(探针) 查询 message_id: ${currentMessageId} 时接口失败，将继续向前查找。错误: ${error}`, 'warn');
      }
    }
    logProbe('[StateFinder] 查找失败：遍历完所有消息楼层，均未找到有效的 stat_data。', 'warn');
    return null;
  } catch (error) {
    logProbe(`[StateFinder] 在获取聊天记录时发生严重错误: ${error}`, 'error');
    return null;
  } finally {
    logProbe('', 'groupEnd');
  }
}

/**
 * @description [职责单一] 找到、解析、验证并准备好【可供运行时直接使用】的音乐配置。
 * @returns {Promise<{ playlists: Record<string, PlaylistConfig>, defaultId: string, triggers: Trigger[] } | null>}
 *          一个包含了【 playlists 映射 】的、完全准备就绪的配置对象，或在失败时返回 null。
 */

async function parseWorldbookConfig() {
  logProbe('[WorldbookParser V4-健壮模式] 开始解析...', 'group');

  // [修改点] 自定义错误类，用于清晰地区分“配置缺失”和“未知错误”
  // 这让我们的错误处理逻辑更符合 SRP 原则
  class ConfigMissingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigMissingError';
    }
  }

  type AggregatedPlaylist = z.infer<typeof ZodPlaylistConfig> & { _sourceFile: string };
  type AggregatedTrigger = z.infer<typeof ZodTriggerConfig> & { _sourceFile: string };

  const aggregatedConfig: {
    playlists: AggregatedPlaylist[];
    triggers: AggregatedTrigger[];
    defaultPlaylistId?: string;
    _defaultPlaylistIdSourceFile: string | null;
    explicitMvuMode?: boolean;
  } = {
    playlists: [],
    triggers: [],
    defaultPlaylistId: undefined,
    _defaultPlaylistIdSourceFile: null,
    explicitMvuMode: undefined,
  };

  try {
    // 前置检查：在执行任何复杂逻辑前，首先确认世界书数据是否可访问。
    const worldbookNames = getCharWorldbookNames('current');
    const searchOrder = [worldbookNames.primary, ...worldbookNames.additional].filter(Boolean);

    // 如果角色卡没有关联任何世界书，直接抛出我们自定义的错误
    if (searchOrder.length === 0) {
      throw new ConfigMissingError('角色卡未关联任何世界书。');
    }

    let foundAnyConfigEntry = false;

    for (const bookName of searchOrder) {
      if (!bookName) continue;
      const entries = await getWorldbook(bookName);
      const configEntries = entries.filter(e => e.name.includes('[MusicConfig]'));

      if (configEntries.length > 0) {
        foundAnyConfigEntry = true;
      }

      for (const entry of configEntries) {
        logProbe(`[Parser V4] 发现并处理配置文件: "${entry.name}"`);
        try {
          const rawConfig = YAML.parse(entry.content);
          const validationResult = ZodWorldbookConfig.safeParse(rawConfig);

          if (!validationResult.success) {
            logProbe(`[Parser V4] 条目 "${entry.name}" Zod验证失败，已跳过。`, 'error');
            _formatZodErrorForToastr(validationResult.error);
            continue;
          }

          const data = validationResult.data;

          if (data.playlists) {
            aggregatedConfig.playlists.push(...data.playlists.map(p => ({ ...p, _sourceFile: entry.name })));
          }
          if (data.triggers) {
            aggregatedConfig.triggers.push(...data.triggers.map(t => ({ ...t, _sourceFile: entry.name })));
          }
          if (data.default_playlist_id) {
            if (aggregatedConfig.defaultPlaylistId && aggregatedConfig.defaultPlaylistId !== data.default_playlist_id) {
              const warningMsg = `在文件 "${entry.name}" 中发现的 default_playlist_id ("${data.default_playlist_id}") 覆盖了来自文件 "${aggregatedConfig._defaultPlaylistIdSourceFile ?? '未知'}" 的定义 ("${aggregatedConfig.defaultPlaylistId}")。为确保行为可预测，建议只保留一个定义。`;
              logProbe(`[Parser V4] ${warningMsg}`, 'warn');
              toastr.warning(warningMsg, '配置警告', { timeOut: 20000, closeButton: true });
            }
            aggregatedConfig.defaultPlaylistId = data.default_playlist_id;
            aggregatedConfig._defaultPlaylistIdSourceFile = entry.name;
          }
          if (data.is_mvu !== undefined) {
            aggregatedConfig.explicitMvuMode = data.is_mvu;
            logProbe(`[Parser V9.5] (配置) 在文件 "${entry.name}" 中读取到显式模式设置: is_mvu = ${data.is_mvu}`);
          }
        } catch (e: any) {
          logProbe(`[Parser V4] 解析条目 "${entry.name}" 时发生YAML语法错误: ${e.message}`, 'error');
          toastr.error(`[MusicConfig] 文件 "${entry.name}" 格式错误：YAML 语法不正确。`, '配置错误', {
            timeOut: 10000,
          });
        }
      }
    }

    // 在所有文件都检查完之后，再判断是否找到了任何 [MusicConfig] 条目
    if (!foundAnyConfigEntry) {
      throw new ConfigMissingError('在已关联的世界书中，未找到任何包含 [MusicConfig] 的条目。');
    }

    // 模式推断与虚拟触发器生成
    let finalIsMvu = false;

    // 1. 优先级判断: 显式配置 > 自动推断
    if (aggregatedConfig.explicitMvuMode !== undefined) {
      finalIsMvu = aggregatedConfig.explicitMvuMode;
      logProbe(`[Parser V9.5] (决策) 遵循显式配置，运行模式锁定为: ${finalIsMvu ? 'MVU模式' : '纯文字模式'}`);
    } else {
      // 2. 自动推断: 有触发器就是 MVU，否则是纯文字
      finalIsMvu = aggregatedConfig.triggers.length > 0;
      logProbe(
        `[Parser V9.5] (决策) 基于内容自动推断，运行模式锁定为: ${finalIsMvu ? 'MVU模式 (发现触发器)' : '纯文字模式 (无触发器)'}`,
      );
    }

    // 3. 纯文字模式下的虚拟化处理
    if (!finalIsMvu) {
      const uniquePlaylistIds = new Set(aggregatedConfig.playlists.map(p => p.id));
      logProbe(`[Parser V9.5] (虚拟化) 正在为 ${uniquePlaylistIds.size} 个歌单生成隐式触发器...`);

      for (const pid of uniquePlaylistIds) {
        const virtualTrigger: AggregatedTrigger = {
          type: 'mvu_variable',
          playlist_id: pid,
          priority: 0,
          conditions: [
            {
              variable_path: 'virtual.music_tag',
              value: pid.toLowerCase(),
            },
          ],
          _sourceFile: 'System_Auto_Generated',
        };
        aggregatedConfig.triggers.push(virtualTrigger);
      }
      logProbe(
        `[Parser V9.5] (虚拟化) 生成完成。系统现在可以识别 <scene:${Array.from(uniquePlaylistIds)[0]}...> 等标签。`,
      );
    }

    // --- 全局健全性检查 (逻辑保持不变) ---
    logProbe('[Parser V4] 所有文件聚合完毕，开始执行全局健全性检查...', 'groupCollapsed');
    let isGloballyValid = true;
    const playlistsById = _.groupBy(aggregatedConfig.playlists, 'id');
    for (const id in playlistsById) {
      if (playlistsById[id].length > 1) {
        const sources = playlistsById[id].map(p => p._sourceFile).join(', ');
        const errorMsg = `[MusicConfig] 致命错误: 歌单 ID "${id}" 在多个文件中重复定义。来源: ${sources}。ID 必须是唯一的。`;
        logProbe(errorMsg, 'error');
        toastr.error(errorMsg, '配置冲突', { timeOut: 15000 });
        isGloballyValid = false;
      }
    }
    const allPlaylistIds = new Set(aggregatedConfig.playlists.map(p => p.id));
    if (aggregatedConfig.defaultPlaylistId && !allPlaylistIds.has(aggregatedConfig.defaultPlaylistId)) {
      const errorMsg = `[MusicConfig] 配置错误: 最终的 default_playlist_id ("${aggregatedConfig.defaultPlaylistId}", 来自文件 "${aggregatedConfig._defaultPlaylistIdSourceFile ?? '未知'}") 指向了一个不存在的歌单。`;
      logProbe(errorMsg, 'error');
      toastr.error(errorMsg, '配置错误', { timeOut: 15000 });
      aggregatedConfig.defaultPlaylistId = undefined;
    }
    const finalTriggers = aggregatedConfig.triggers.filter(trigger => {
      if (allPlaylistIds.has(trigger.playlist_id)) {
        return true;
      }
      const errorMsg = `[MusicConfig] 校验失败: 来自文件 "${trigger._sourceFile}" 的触发器指向了不存在的歌单ID "${trigger.playlist_id}"。该触发器将被忽略。`;
      logProbe(errorMsg, 'error');
      toastr.error(errorMsg, '配置错误', { timeOut: 10000 });
      return false;
    });

    if (!isGloballyValid) {
      logProbe('[Parser V4] 全局健全性检查失败，配置被拒绝。', 'error');
      logProbe('', 'groupEnd');
      logProbe('', 'groupEnd');
      return null;
    }
    logProbe('[Parser V4] 全局健全性检查通过。');
    logProbe('', 'groupEnd');

    if (aggregatedConfig.playlists.length === 0) {
      throw new ConfigMissingError('所有配置文件中都未能找到任何有效的歌单 (playlists)。');
    }

    // --- 数据归一化并返回 ---
    const playlistsAsMap: Record<string, PlaylistConfig> = {};
    for (const pl of aggregatedConfig.playlists) {
      const normalizedTracks = pl.tracks.map(track => ({
        url: track.url,
        歌名:
          track.歌名 && track.歌名.trim() !== ''
            ? track.歌名
            : decodeURIComponent(track.url.split('/').pop()?.split('?')[0] || '未知歌曲'),
        歌手: track.歌手,
        封面: track.封面,
      }));

      playlistsAsMap[pl.id] = { ..._.omit(pl, '_sourceFile'), tracks: normalizedTracks };
    }

    const finalConfig = {
      playlists: playlistsAsMap,
      defaultId: aggregatedConfig.defaultPlaylistId,
      triggers: finalTriggers.map(t => _.omit(t, '_sourceFile')),
      isMvu: finalIsMvu,
    };

    logProbe('[Parser V4] 数据归一化完成，运行时配置已就绪。', 'log');
    logProbe('', 'groupEnd');
    return finalConfig;
  } catch (error) {
    // 这是新的、更智能的错误处理中心
    if (error instanceof ConfigMissingError) {
      // 判断这个错误是不是我们自己抛出的“配置缺失”错误
      logProbe(`[Parser V4] 捕获到可预见的配置错误: ${error.message}`, 'error');

      // [核心修改] 直接使用 error.message 作为 toastr 的提示内容
      // 这确保了我们抛出的具体错误信息能够直接呈现给用户
      toastr.error(error.message, '[音乐播放器] 配置缺失', {
        timeOut: 20000,
        closeButton: true,
      });
    } else {
      // 如果是其他所有无法预料的错误，比如酒馆环境问题
      logProbe(`[Parser V4] 解析过程中发生意外顶层错误: ${error}`, 'error');
      // 显示通用的、建议用户刷新的提示
      toastr.error(
        '播放器在加载设置时遇到一个临时问题。这通常可以通过按 F5 刷新酒馆页面来解决。',
        '[音乐播放器] 加载时遇到临时问题',
        {
          timeOut: 20000,
          closeButton: true,
        },
      );
    }
    logProbe('', 'groupEnd');
    return null;
  }
}

/**
 * [工厂 V3.0] 从持久化对象重建一个完整的、可供运行时使用的 QueueItem。
 * @param persistedItem - 从酒馆变量读取的、经过 Zod 验证的item。
 * @param playlistConfig - 从当前世界书解析出的对应歌单配置。
 * @returns {QueueItem} 一个完整的运行时 QueueItem。
 */
function reconstituteQueueItem(
  persistedItem: z.infer<typeof ZodQueueItemState>,
  playlistConfig: PlaylistConfig,
): QueueItem {
  return {
    playlistId: persistedItem.playlistId,
    priority: persistedItem.triggerSource?.priority ?? -Infinity,
    playlistContent: _.cloneDeep(playlistConfig.tracks),
    onFinishRule: playlistConfig.onFinishRule,
    currentIndex: persistedItem.currentIndex,
    playedIndices: new Set(persistedItem.playedIndices),
    wasEverPlayed: persistedItem.wasEverPlayed,
    triggeredBy: persistedItem.triggerSource ? 'mvu' : 'base',
    triggerSource: persistedItem.triggerSource,
  };
}

type CreateQueueItemConfig =
  | { type: 'base'; playlistId: string }
  | { type: 'mvu'; playlistId: string; trigger: z.infer<typeof ZodTriggerConfig> };

/**
 * [工厂 V3.0] 创建一个全新的、状态初始化的 QueueItem。
 * @param config - 一个包含所有必要信息的配置对象。
 * @returns {QueueItem | null} 一个完整的队列项，或在失败时返回 null。
 */
function createQueueItem(config: CreateQueueItemConfig): QueueItem | null {
  const { playlistId } = config;

  if (!playlistId || !allPlaylists[playlistId]) {
    logProbe(`[Factory] 创建队列项失败：请求的歌单ID "${playlistId}" 不存在。`, 'error');
    return null;
  }

  const playlistConfig = allPlaylists[playlistId];

  const baseItem: Omit<QueueItem, 'triggeredBy' | 'triggerSource' | 'onFinishRule' | 'priority'> = {
    playlistId: playlistId,
    playlistContent: _.cloneDeep(playlistConfig.tracks),
    currentIndex: 0,
    playedIndices: new Set(),
    wasEverPlayed: false,
  };

  if (config.type === 'base') {
    return {
      ...baseItem,
      priority: -Infinity,
      triggeredBy: 'base',
      onFinishRule: playlistConfig.onFinishRule ?? 'loop',
    };
  } else {
    return {
      ...baseItem,
      priority: config.trigger.priority,
      triggeredBy: 'mvu',
      onFinishRule: playlistConfig.onFinishRule,
      triggerSource: config.trigger,
    };
  }
}

// =================================================================
// 7. 运行时初始化与播放器控制 (Runtime & Player Controls)
// =================================================================

async function initializePlayerForChat(
  config: any,
  authoritativeState: any,
  options?: { autoPlayIfWasPlaying?: boolean },
) {
  logProbe('=== 开始执行【核心·自愈式初始化】 V9.0 ===', 'group');
  try {
    // --- 【准备阶段】 清理与重置 ---
    isCorePlayerInitialized = true;
    // 注意：StateReset 会重置内存，所以我们需要先读档，再根据读档结果恢复必要的记忆
    const savedState = readState();
    StateManager.resetState();

    if (savedState) {
      // 恢复基础状态（此时 active_queue 还是空的，将在后面重建）
      StateManager.loadState(savedState);
    }

    MvuManager.resetState();
    MvuManager.initialize();
    const activePlayer = PlaybackEngine.getActivePlayer();
    if (activePlayer) activePlayer.pause();
    triggers = [];
    allPlaylists = {};
    defaultPlaylistId = '';

    if (!config) {
      logProbe('[Initializer] 配置无效，初始化中止。', 'error');
      broadcastFullState();
      throw new Error('世界书音乐配置解析失败，请检查配置。');
    }

    allPlaylists = config.playlists;
    defaultPlaylistId = config.defaultId;
    triggers = config.triggers;

    isMvuMode = config.isMvu;
    logProbe(`[Initializer] 全局运行模式已固化: ${isMvuMode ? 'MVU 交响乐模式' : '纯文字 吟游诗人模式'}`);

    const currentStatData = authoritativeState?.mvuData?.stat_data ?? null;
    const authoritativeMessageId = authoritativeState?.messageId;

    let finalQueue: QueueItem[] = [];

    // --- 【第一步】 确定并验证权威的基础歌单 ID ---
    let correctBasePlaylistId = defaultPlaylistId;

    const msgZero = getChatMessages(0, { include_swipes: true })[0];
    const currentSwipeId = msgZero?.swipe_id ?? 0;

    if (msgZero) {
      const currentGreeting = msgZero.swipes?.[msgZero.swipe_id];
      const tagMatch = currentGreeting?.match(/<playlist:([^>]+)>/);
      if (tagMatch && tagMatch[1]) {
        const tagPlaylistId = tagMatch[1];
        if (allPlaylists[tagPlaylistId]) {
          logProbe(`[Initializer-Heal] (基准) 从开场白标签确定权威基础歌单: "${tagPlaylistId}"`);
          correctBasePlaylistId = tagPlaylistId;
        } else {
          const errorMsg = `[MusicConfig] 配置警告: 开场白标签 <playlist:${tagPlaylistId}> 指向了一个不存在的歌单ID。将回退至默认歌单。`;
          logProbe(errorMsg, 'warn');
          toastr.warning(errorMsg, '配置警告', { timeOut: 15000 });
        }
      } else {
        logProbe(`[Initializer-Heal] (基准) 开场白无标签，使用世界书默认歌单: "${defaultPlaylistId ?? '无'}"`);
      }
    }

    const lastSwipeId = StateManager.getLastActiveSwipeId();

    if (lastSwipeId !== null && lastSwipeId !== currentSwipeId) {
      logProbe(`[Initializer] (上下文切换) 检测到平行宇宙跃迁: Swipe ${lastSwipeId} -> ${currentSwipeId}。`, 'warn');
      logProbe(`[Initializer] (决策) 旧时间线的墓志铭已失效，正在清空...`);
      StateManager.clearFinishedBasePlaylists();
    } else {
      logProbe(`[Initializer] (上下文保持) 同一时间线 (Swipe ${currentSwipeId})，保持墓志铭记录。`);
    }
    // 更新当前锚点
    StateManager.setLastActiveSwipeId(currentSwipeId);

    // 检查 4: 基础歌单与场景歌单冲突检查
    if (config.isMvu && correctBasePlaylistId) {
      const scenePlaylistIds = new Set(triggers.map(t => t.playlist_id));
      if (scenePlaylistIds.has(correctBasePlaylistId)) {
        const fatalErrorMsg = `[MusicConfig] 致命配置错误: 歌单 "${correctBasePlaylistId}" 不能同时被用作基础歌单（在开场白或默认设置中）和场景歌单（被触发器关联）。请为它们使用不同的歌单。`;
        logProbe(fatalErrorMsg, 'error');
        toastr.error(fatalErrorMsg, '配置冲突', { timeOut: 20000, closeButton: true });
        throw new Error('基础歌单与场景歌单存在致命冲突。');
      }
    } else if (!config.isMvu && correctBasePlaylistId) {
      logProbe(`[Initializer] (冲突豁免) 纯文字模式下，跳过基础/场景歌单重名检查。`);
    }

    // --- 【第二步】 队列净化与重建 (Heal the Past) ---
    if (savedState) {
      logProbe('[Initializer-Heal] (净化) 开始审查存档...', 'groupCollapsed');
      const healedQueue: QueueItem[] = [];
      // 注意：此时我们使用的是 savedState.active_queue，而不是 StateManager 中的（因为 resetState 会清空）
      for (const persistedItem of savedState.active_queue) {
        if (!Object.prototype.hasOwnProperty.call(allPlaylists, persistedItem.playlistId)) {
          logProbe(`(净化-丢弃) 存档歌单 "${persistedItem.playlistId}" 已不存在。`, 'warn');
          continue;
        }

        const playlistConfig = allPlaylists[persistedItem.playlistId];
        const isBaseItem = !persistedItem.triggerSource;

        if (isBaseItem) {
          if (persistedItem.playlistId === correctBasePlaylistId) {
            logProbe(`(净化-保留) 基础歌单 "${persistedItem.playlistId}" 仍然有效。`);
            healedQueue.push(reconstituteQueueItem(persistedItem, playlistConfig));
          } else {
            logProbe(
              `(净化-丢弃) 基础歌单 "${persistedItem.playlistId}" 已被新的权威歌单 "${correctBasePlaylistId ?? '无'}" 替代。`,
              'warn',
            );
          }
        } else {
          const currentTrigger = triggers.find(t => t.playlist_id === persistedItem.playlistId);
          logProbe(`(探针-净化) 正在审查存档的MVU歌单 "${persistedItem.playlistId}"...`);

          if (playlistConfig.onFinishRule === 'pop') {
            logProbe(`(净化-丢弃) 原因：规则为 'pop' (场景歌单不应跨会话保留)。`);
            continue;
          }

          if (!currentTrigger) {
            logProbe(`(净化-丢弃) 原因：在最新的世界书配置中已找不到对应的触发器。`, 'warn');
            continue;
          }

          if (!MvuManager.checkTriggerCondition(currentTrigger, currentStatData)) {
            logProbe(`(净化-丢弃) 原因：最新的触发器条件在当前状态下不满足。`);
            continue;
          }

          logProbe(`(净化-保留) 验证通过。`);
          healedQueue.push(reconstituteQueueItem(persistedItem, playlistConfig));
        }
      }
      finalQueue = healedQueue;
      logProbe('[Initializer-Heal] (净化) 审查完成。', 'groupEnd');
    }

    // --- 【第三步】 队列补充 ---
    if (currentStatData && triggers.length > 0) {
      logProbe('[Initializer-Heal] (补充) 正在检查是否有新激活的场景歌单...', 'groupCollapsed');
      for (const trigger of triggers) {
        const alreadyExists = finalQueue.some(
          item => item.triggerSource && areTriggersFunctionallyEqual(item.triggerSource, trigger),
        );

        if (!alreadyExists && MvuManager.checkTriggerCondition(trigger, currentStatData)) {
          const playlistConfig = allPlaylists[trigger.playlist_id];
          if (playlistConfig && playlistConfig.onFinishRule === 'pop') {
            if (authoritativeMessageId === 0) {
              logProbe(`(补充) 允许添加 'pop' 歌单 "${trigger.playlist_id}"，因为上下文是开场白。`);
              const newItem = createQueueItem({ type: 'mvu', playlistId: trigger.playlist_id, trigger: trigger });
              if (newItem) finalQueue.push(newItem);
            } else {
              logProbe(
                `(补充-阻止) 场景歌单 "${trigger.playlist_id}" 因规则为 'pop' 且上下文非开场白而被忽略。`,
                'warn',
              );
            }
          } else {
            const newItem = createQueueItem({ type: 'mvu', playlistId: trigger.playlist_id, trigger: trigger });
            if (newItem) finalQueue.push(newItem);
          }
        }
      }
      logProbe('[Initializer-Heal] (补充) 检查完成。', 'groupEnd');
    }

    // --- 【第四步】 基础歌单最终注入 (Final Guarantee V2.0) ---
    const basePlaylistExists = finalQueue.some(item => item.triggeredBy === 'base');
    if (!basePlaylistExists && correctBasePlaylistId && allPlaylists[correctBasePlaylistId]) {
      const isDead = StateManager.getFinishedBasePlaylists().has(correctBasePlaylistId);

      if (isDead) {
        logProbe(
          `[Initializer-Heal] (注入-阻止) 基础歌单 "${correctBasePlaylistId}" 在此上下文(Swipe ${currentSwipeId})中已完结(墓志铭在册)。尊重历史，拒绝复活。`,
        );
      } else {
        logProbe(`[Initializer-Heal] (注入) 最终注入权威基础歌单 "${correctBasePlaylistId}"。`);
        const baseItem = createQueueItem({ type: 'base', playlistId: correctBasePlaylistId });
        if (baseItem) finalQueue.push(baseItem);
      }
    }

    // --- 【第五步】 最终加载与后续设置 ---
    logProbe('[Initializer-Finalize] 正在提交最终队列并完成设置...');
    StateManager.updateQueue(finalQueue);

    // 注意：如果 resetState 重置了模式，我们需要从 savedState 恢复，或者使用默认
    // 之前的代码是在 resetState 后直接覆盖，但这里我们利用 loadState 已经恢复了一部分
    // 我们需要确保 StrategyManager 同步
    const mode = StateManager.getPlaybackMode();
    StrategyManager.setMode(mode);
    logProbe(`(探针) 策略模式已同步为: ${mode}`);
    StrategyManager.notifyQueueChanged();

    PlaybackEngine.initialize();

    const volume = StateManager.getVolume();
    if (PlaybackEngine.getActivePlayer()) PlaybackEngine.getActivePlayer()!.volume = volume;
    if (PlaybackEngine.getStandbyPlayer()) PlaybackEngine.getStandbyPlayer()!.volume = 0;

    const initialTopItem = StateManager.getTopQueueItem();
    if (initialTopItem) {
      const track = initialTopItem.playlistContent[initialTopItem.currentIndex];
      if (track && PlaybackEngine.getActivePlayer()) {
        PlaybackEngine.getActivePlayer()!.src = track.url;
      }
    } else {
      logProbe(`[Initializer] (探针) 最终队列为空（可能因基础歌单已完结），不执行音频预加载。`);
    }

    if (currentStatData) {
      await MvuManager.persistCurrentState(currentStatData);
      logProbe('[Initializer-Finalize]  已将本次创世的权威MVU状态持久化为历史基准。');
    } else {
      await MvuManager.persistCurrentState({});
      logProbe('[Initializer-Finalize] 当前无MVU状态，已将空状态持久化为历史基准。');
    }

    await writeState('initialization');
    broadcastFullState();

    if (options?.autoPlayIfWasPlaying) {
      logProbe('[Initializer] (探针) 检测到来自开场白滑动的“自动播放”意图。', 'warn');
      const currentItem = StateManager.getTopQueueItem();
      if (currentItem) {
        logProbe('[Initializer] 新的开场白已配置歌单，将执行“创世播放”...');
        await _handleGenesisPlay();
      } else {
        logProbe('[Initializer] 新的开场白未配置歌单，自动播放已取消。');
      }
    }
  } catch (error) {
    logProbe(`[Initializer] 核心初始化过程中发生严重错误: ${error}`, 'error');
    console.error(error);
    throw error;
  } finally {
    logProbe('=== 【核心·自愈式初始化】执行完毕 ===', 'groupEnd');
  }
}

/**
 * @description 【V8.2 核心】播放执行器。
 *              它的单一职责是：接收一个目标索引，并尝试播放它。
 *              它会返回一个 Promise，成功时 resolve，失败时 reject，将错误冒泡给调用者处理。
 *              它自身不包含任何重试或自愈逻辑。
 */
async function _executeTransition(targetIndex: number): Promise<void> {
  logProbe(`[Executor] 收到播放指令，目标索引: ${targetIndex}`, 'group');

  const freshItem = StateManager.getTopQueueItem();
  if (!freshItem) {
    logProbe(`[Executor] 执行中止：无有效队列项`, 'warn');
    logProbe('', 'groupEnd');
    return Promise.resolve();
  }

  const targetTrack = freshItem.playlistContent[targetIndex];
  if (!targetTrack?.url) {
    logProbe(`[Executor] 执行失败：在索引 ${targetIndex} 处找不到音轨或音轨URL无效。`, 'error');
    logProbe('', 'groupEnd');
    throw new Error(`Invalid track at index ${targetIndex}`);
  }

  try {
    await PlaybackEngine.transitionToTrack(targetTrack.url, StateManager.getVolume());

    StateManager.setPlaybackState('PLAYING');
    prepareNextTrack();
    logProbe(`[Executor] 索引 ${targetIndex} 播放成功。`);
  } catch (error) {
    logProbe(`[Executor] PlaybackEngine报告播放失败。原因: ${error}`, 'error');
    throw error;
  } finally {
    logProbe('', 'groupEnd');
  }
}

/**
 * @description 【V8.2 核心】迭代式自愈循环。
 *              此最终版严格遵守 SRP 原则，将决策应用逻辑完全委托给 _applyNavigationDecision。
 */
async function _executeSelfHealingLoop(): Promise<void> {
  logProbe('[SelfHeal] 启动“迭代式自愈循环”... 播放器进入紧急自愈模式。', 'warn');

  let consecutiveFailures = 1;
  const currentItemForThreshold = StateManager.getTopQueueItem();
  const threshold = currentItemForThreshold?.playlistContent.length ?? 0;

  if (currentItemForThreshold) {
    toastr.error(
      `歌曲《${currentItemForThreshold.playlistContent[currentItemForThreshold.currentIndex]?.歌名 ?? '未知歌曲'}》加载失败，正在尝试自动处理...`,
    );
  }

  while (true) {
    if (threshold > 0 && consecutiveFailures >= threshold) {
      logProbe(
        `[SelfHeal] (熔断器) 连续失败 ${consecutiveFailures} 次，已达到或超过阈值 ${threshold}。自愈中止。`,
        'error',
      );
      if (currentItemForThreshold) {
        toastr.error(`歌单《${currentItemForThreshold.playlistId}》中所有歌曲均无法加载，播放已停止。`);
      }
      StateManager.setPlaybackState('STOPPED');
      broadcastFullState();
      return;
    }

    const currentItem = StateManager.getTopQueueItem();
    if (!currentItem) {
      logProbe('[SelfHeal] 自愈中止：中途队列变空。', 'warn');
      StateManager.setPlaybackState('STOPPED');
      broadcastFullState();
      return;
    }

    const errorDecision = StrategyManager.getCurrentStrategy().onPlaybackError(currentItem);
    logProbe(
      `[SelfHeal] 收到策略 (${StrategyManager.getCurrentStrategy().constructor.name}) 的错误决策: { action: '${errorDecision.action}' }`,
    );

    const directive = await _applyNavigationDecision(errorDecision);

    if (!directive.needsAsyncEffect) {
      logProbe('[SelfHeal] 决策应用后无需播放，自愈中止。');
      // 注意：applyNavigationDecision 内部已经处理了 setPlaying(false) 和广播
      return;
    }

    // 防御性编程：确保 targetIndex 存在
    if (typeof directive.targetIndex !== 'number') {
      logProbe('[SelfHeal] 决策应用后需要播放，但没有有效的 targetIndex。自愈中止。', 'error');
      StateManager.setPlaybackState('STOPPED');
      broadcastFullState();
      return;
    }

    // 步骤 4: 再次尝试播放
    try {
      await _executeTransition(directive.targetIndex);

      logProbe('[SelfHeal] 播放成功，自愈循环结束。', 'log');
      broadcastFullState();
      return;
    } catch (nextError) {
      consecutiveFailures++;
      const nextTopItem = StateManager.getTopQueueItem();
      const nextTrackTitle = nextTopItem?.playlistContent[nextTopItem.currentIndex]?.歌名 ?? '未知歌曲';
      logProbe(`[SelfHeal] 第 ${consecutiveFailures} 次播放失败:`, 'error');
      console.error(nextError);
      toastr.error(`下一首《${nextTrackTitle}》加载失败...`);
    }
  }
}

async function _applyNavigationDecision(
  decision: StrategyDecision,
): Promise<{ needsAsyncEffect: boolean; targetIndex?: number }> {
  logProbe(
    `[CentralCommand] 正在应用策略决策: { action: '${decision.action}', nextIndex: ${decision.nextIndex ?? 'N/A'} }`,
    'group',
  );

  let needsAsyncEffect = false;
  let targetIndex: number | undefined;

  const currentItem = StateManager.getTopQueueItem();

  switch (decision.action) {
    case 'GoTo': {
      if (typeof decision.nextIndex === 'number') {
        logProbe('[CentralCommand] 指令: GoTo。提交导航步骤...');
        StateManager.commitNavigationStep(decision.nextIndex);
        needsAsyncEffect = true;
        targetIndex = decision.nextIndex;
      } else {
        logProbe('[CentralCommand] 致命逻辑错误: GoTo 指令缺少 nextIndex！这是一个策略模块的BUG。', 'error');
        console.error('探针捕获：错误的决策对象:', decision);
        console.error('探针捕获：发生错误时的播放器状态:', StateManager.getStateSnapshotForRuntime());
        needsAsyncEffect = false;
      }
      break;
    }

    case 'Restart': {
      logProbe('[CentralCommand] 指令: Restart。请求从头重播当前轨道。');
      if (currentItem) {
        logProbe('[CentralCommand] (探针) 此决策不改变状态索引，仅生成一个效果指令。');
        needsAsyncEffect = true;
        targetIndex = currentItem.currentIndex;
      }
      break;
    }

    case 'RemoveTopAndAdvance': {
      logProbe('[CentralCommand] 指令: RemoveTopAndAdvance。正在执行【自洽式】队列修改与过渡...');
      const itemToRemove = StateManager.getTopQueueItem();
      if (itemToRemove && itemToRemove.triggeredBy === 'base' && itemToRemove.onFinishRule === 'pop') {
        logProbe(`[CentralCommand] (死亡登记) 基础歌单 "${itemToRemove.playlistId}" 即将离场`, 'warn');
        StateManager.addToFinishedBasePlaylists(itemToRemove.playlistId);
      }
      const currentQueue = StateManager.getQueue();

      const poppedItem = currentQueue.shift();
      logProbe(`(探针) 已从队列中移除: "${poppedItem?.playlistId}"`);

      StateManager.updateQueue(currentQueue);

      logProbe('[CentralCommand] (握手) 正在通知 StrategyManager 队列已变更...');
      StrategyManager.notifyQueueChanged();

      const newTopItem = StateManager.getTopQueueItem();
      if (newTopItem) {
        logProbe(`(决策) 新队首为 "${newTopItem.playlistId}"，准备过渡到其当前索引: ${newTopItem.currentIndex}`);
        needsAsyncEffect = true;
        targetIndex = newTopItem.currentIndex;
      } else {
        logProbe('(决策) 队列已空，停止播放。');
        logProbe('[CentralCommand] (修复) 检测到队列清空，正在下达物理静音指令...');
        await PlaybackEngine.fadeOutAndPause();
        StateManager.setPlaybackState('STOPPED');
        needsAsyncEffect = false;
      }

      break;
    }

    case 'LoopReset': {
      logProbe('[CentralCommand] 指令: LoopReset。执行“指挥家模型”...', 'warn');
      StateManager.resetCurrentItemForLoop();
      const currentMode = StateManager.getPlaybackMode();
      if (currentMode === 'random') {
        logProbe('(指挥) 检测到随机模式，向作曲家索要新乐谱...');
        const genesisPlan = (StrategyManager.getCurrentStrategy() as RandomStrategy).prepareGenesis(
          StateManager.getTopQueueItem(),
        );
        if (genesisPlan) {
          StateManager.commitGenesisState(
            genesisPlan.newCurrentIndex,
            genesisPlan.newPlaybackPlan,
            genesisPlan.newPlanIndex,
          );
        }
      }
      const finalStartIndex = StateManager.getTopQueueItem()?.currentIndex ?? 0;
      logProbe(`(指挥) 流程完成。最终确定的新起始索引为: ${finalStartIndex}`);
      needsAsyncEffect = true;
      targetIndex = finalStartIndex;
      break;
    }

    case 'Stop': {
      logProbe('[CentralCommand] 指令: Stop。停止播放。');
      StateManager.setPlaybackState('STOPPED');
      break;
    }

    case 'DoNothing':
    default:
      logProbe(`[CentralCommand] 指令: DoNothing。无状态变更。`);
      break;
  }

  if (decision.action !== 'RemoveTopAndAdvance') {
    broadcastFullState();
  }

  const directive = { needsAsyncEffect, targetIndex };
  logProbe(
    `[CentralCommand] 决策应用完成。返回指令: { needsAsyncEffect: ${directive.needsAsyncEffect}, targetIndex: ${directive.targetIndex ?? 'N/A'} }`,
  );
  logProbe('', 'groupEnd');
  return directive;
}

/**
 * @description [V9.6 净化] 释放效果锁并广播最终状态。
 *              这是所有异步控制器 finally 块中的标准“谢幕”程序。
 */
async function _releaseEffectLock() {
  // 探针: 记录锁释放的动作，这对于调试UI卡死问题至关重要
  logProbe('[LockManager] 正在释放效果锁并广播最终状态...');

  StateManager.setPerformingEffect(false);
  broadcastFullState();
}

async function _handleTrackEnded() {
  logProbe('[Controller:TrackEnd] === 开始处理轨道自然结束事件 ===', 'group');
  if (StateManager.isPerformingEffect()) {
    logProbe('[Controller:TrackEnd] 请求被拒绝，因为效果正在执行。', 'warn');
    logProbe('', 'groupEnd');
    return;
  }

  const currentItem = StateManager.getTopQueueItem();
  if (!currentItem) {
    logProbe('[Controller:TrackEnd] 请求中止：队列为空。');
    logProbe('', 'groupEnd');
    return;
  }

  try {
    StateManager.setPerformingEffect(true);
    broadcastFullState();

    const decision = StrategyManager.getCurrentStrategy().onTrackEnd(currentItem);
    const directive = await _applyNavigationDecision(decision);

    if (directive.needsAsyncEffect && typeof directive.targetIndex === 'number') {
      await _executeTransition(directive.targetIndex);
    }
  } catch (error) {
    logProbe(`[Controller:TrackEnd] 在执行效果时捕获到错误，将启动自愈循环...`, 'error');
    console.error(error);
    await _executeSelfHealingLoop();
  } finally {
    await _releaseEffectLock();
    await writeState('trackEnded');
    logProbe('[Controller:TrackEnd] === 轨道结束事件处理完毕 (锁已通过调度器释放) ===', 'groupEnd');
  }
}

// =================================================================
// 8. 全局API与事件系统 (Global API & Event System)
// =================================================================

async function _handleNavigation(direction: 'next' | 'prev') {
  logProbe(`[Controller:Nav] === 开始处理用户导航事件 (方向: ${direction}) ===`, 'group');
  if (StateManager.isPerformingEffect()) {
    logProbe(`[Controller:Nav] 请求被拒绝，因为效果正在执行。`, 'warn');
    logProbe('', 'groupEnd');
    return;
  }

  const currentItem = StateManager.getTopQueueItem();
  if (!currentItem) {
    logProbe(`[Controller:Nav] 请求中止：队列为空。`);
    logProbe('', 'groupEnd');
    return;
  }

  try {
    StateManager.setPerformingEffect(true);
    broadcastFullState();

    const decision = StrategyManager.getCurrentStrategy().advance(currentItem, direction);
    const directive = await _applyNavigationDecision(decision);

    logProbe(
      `[Controller:Nav] (探针) 原始决策: ${decision.action}, 处理指令: needsAsyncEffect=${directive.needsAsyncEffect}`,
    );

    if (decision.action === 'Restart') {
      logProbe(`[Controller:Nav] 检测到 Restart 决策，执行 seek(0) 效果。`);
      const activePlayer = PlaybackEngine.getActivePlayer();
      if (activePlayer) activePlayer.currentTime = 0;
      if (StateManager.getPlaybackMode() !== 'single') {
        toastr.info('已是第一首');
      }
    } else if (directive.needsAsyncEffect && typeof directive.targetIndex === 'number') {
      await _executeTransition(directive.targetIndex);
    } else if (decision.action === 'DoNothing') {
      toastr.info(direction === 'next' ? '已是歌单最后一首。' : '已是歌单第一首。');
    }
  } catch (error) {
    logProbe(`[Controller:Nav] 在执行效果时捕获到错误，将启动自愈循环...`, 'error');
    console.error(error);
    await _executeSelfHealingLoop();
  } finally {
    await _releaseEffectLock();
    await writeState('navigation');
    logProbe(`[Controller:Nav] === 用户导航事件处理完毕 (锁已通过调度器释放) ===`, 'groupEnd');
  }
}

/**
 * [内部核心] 执行创世播放的实际逻辑。
 * 注意：此函数不检查也不设置效果锁，调用者必须确保已持有锁。
 */
async function _executeGenesisPlayInternal(targetIndex: number) {
  logProbe(`[Internal:Genesis] (动作) 执行内部创世播放逻辑 (目标索引: ${targetIndex})...`);
  StateManager.setPlaybackState('PLAYING');
  broadcastFullState();
  await _executeTransition(targetIndex);
}

async function _handleGenesisPlay() {
  if (StateManager.isPerformingEffect()) {
    logProbe('[Controller:Genesis] 请求被拒绝，因为效果正在执行。', 'warn');
    return;
  }

  const currentItem = StateManager.getTopQueueItem();
  if (!currentItem) {
    logProbe('[Controller:Genesis] 请求中止：播放列表为空。');
    return;
  }

  try {
    StateManager.setPerformingEffect(true);
    logProbe(`[Controller:Genesis] === “创世播放”效果开始 (目标索引: ${currentItem.currentIndex}) ===`, 'group');

    await _executeGenesisPlayInternal(currentItem.currentIndex);
  } catch (error) {
    logProbe(`[Controller:Genesis] “创世播放”效果执行时发生意外顶层错误: ${error}`, 'error');
    StateManager.setPlaybackState('STOPPED');
    broadcastFullState();
  } finally {
    await _releaseEffectLock();
    await writeState('genesisPlay');
    logProbe(`[Controller:Genesis] === “创世播放”效果结束 (锁已通过调度器释放) ===`, 'groupEnd');
  }
}

async function _handlePlayIndex(index: number) {
  logProbe(`[Controller:PlayIndex] === 开始处理索引播放事件 (目标: ${index}) ===`, 'group');
  if (StateManager.isPerformingEffect()) {
    logProbe(`[Controller:PlayIndex] 请求被拒绝，因为效果正在执行。`, 'warn');
    logProbe('', 'groupEnd');
    return;
  }

  try {
    StateManager.setPerformingEffect(true);
    broadcastFullState();

    const currentItem = StateManager.getTopQueueItem();
    const currentMode = StateManager.getPlaybackMode();

    if (currentItem && index === currentItem.currentIndex) {
      logProbe(`[Controller:PlayIndex] (决策) 用户点击了当前歌曲，将从头重播。`);
      const activePlayer = PlaybackEngine.getActivePlayer();
      if (activePlayer) activePlayer.currentTime = 0;
    } else if (currentMode === 'list' || currentMode === 'single') {
      logProbe(`[Controller:PlayIndex] (决策) ${currentMode} 模式，执行标准跳转...`);
      StateManager.setCurrentIndex(index);
      await _executeTransition(index);
    } else if (currentMode === 'random') {
      logProbe(`[Controller:PlayIndex] (决策) random 模式，执行“用户跳转”高级逻辑...`);
      StateManager.userInitiatedJump(index);
      await _executeTransition(index);
    }
  } catch (error) {
    logProbe(`[Controller:PlayIndex] 在执行效果时捕获到错误，将启动自愈循环...`, 'error');
    console.error(error);
    await _executeSelfHealingLoop();
  } finally {
    await _releaseEffectLock();
    await writeState('playIndex');
    logProbe(`[Controller:PlayIndex] === 索引播放事件处理完毕 (锁已通过调度器释放) ===`, 'groupEnd');
  }
}

async function togglePlayPause() {
  logProbe('[Controller:Toggle] === 开始处理播放/暂停切换事件 (三态机版) ===', 'group');

  // 1. 效果锁检查
  if (StateManager.isPerformingEffect()) {
    logProbe('[Controller:Toggle] 请求被拒绝，因为效果正在执行。', 'warn');
    logProbe('', 'groupEnd');
    return;
  }

  // 2. 空队列检查
  const currentItem = StateManager.getTopQueueItem();
  if (!currentItem) {
    logProbe('[Controller:Toggle] 请求中止：播放列表为空。');
    toastr.info('播放列表为空');
    logProbe('', 'groupEnd');
    return;
  }

  try {
    // 3. 上锁并广播
    StateManager.setPerformingEffect(true);
    broadcastFullState();

    const currentState = StateManager.getPlaybackState();
    logProbe(`[Controller:Toggle] 当前状态: ${currentState}`);

    switch (currentState) {
      case 'STOPPED': {
        // [核心] 这是首次播放意图的关键点
        logProbe('[Controller:Toggle] 决策: STOPPED -> PLAYING (视为创世播放)');

        StateManager.setPlaybackState('PLAYING');
        broadcastFullState();

        // 尝试播放当前队首
        // 如果是刚加载的歌单，currentIndex 应该是 0，或者是记忆中的位置
        await _executeTransition(currentItem.currentIndex);
        break;
      }

      case 'PLAYING': {
        logProbe('[Controller:Toggle] 决策: PLAYING -> PAUSED');
        StateManager.setPlaybackState('PAUSED');
        broadcastFullState();
        await PlaybackEngine.fadeOutAndPause();
        break;
      }

      case 'PAUSED': {
        logProbe('[Controller:Toggle] 决策: PAUSED -> PLAYING (恢复)');
        StateManager.setPlaybackState('PLAYING');
        broadcastFullState();
        await PlaybackEngine.resumeAndFadeIn(StateManager.getVolume());
        break;
      }
    }
  } catch (error) {
    logProbe(`[Controller:Toggle] 在执行效果时捕获到错误，将启动自愈循环...`, 'error');
    console.error(error);
    await _executeSelfHealingLoop();
  } finally {
    await _releaseEffectLock();
    await writeState('togglePlayPause');
    logProbe('[Controller:Toggle] === 播放/暂停切换事件处理完毕 (锁已通过调度器释放) ===', 'groupEnd');
  }
}

function playNext() {
  void _handleNavigation('next');
}

function playPrev() {
  void _handleNavigation('prev');
}

function setupGlobalAPI() {
  window.musicPlayerAPI = {
    requestInitialization: (): Promise<void> => {
      if (isInitializedForThisChat) {
        logProbe('[API] requestInitialization (已完成): 一个迟到的界面发来请求，立即返回成功契约。');
        broadcastFullState();
        return Promise.resolve();
      }

      if (!_initializationPromise) {
        logProbe('[API] requestInitialization (首次): 第一个界面请求到达，正在创建【共享的】Promise契约...');
        _initializationPromise = new Promise((resolve, reject) => {
          _initializationPromiseControls = { resolve, reject };
        });
      } else {
        logProbe('[API] requestInitialization (后续): 又一个界面请求到达，返回【已存在的】共享契约。');
      }

      return _initializationPromise;
    },

    togglePlayPause: () => togglePlayPause(),
    playNext: () => playNext(),
    playPrev: () => playPrev(),
    playIndex: (index: number) => {
      const currentItem = StateManager.getTopQueueItem();
      if (currentItem && index >= 0 && index < currentItem.playlistContent.length) {
        void _handlePlayIndex(index);
      }
    },
    persistVolumeAndBroadcast: (volume: number) => {
      const finalVolume = Math.max(0, Math.min(1, volume));
      const activePlayer = PlaybackEngine.getActivePlayer();
      StateManager.setVolume(finalVolume);
      if (activePlayer && !StateManager.isPerformingEffect()) activePlayer.volume = finalVolume;
      void writeState('persistVolume');
      broadcastFullState();
    },
    setLiveVolume: (volume: number) => {
      const activePlayer = PlaybackEngine.getActivePlayer();
      if (activePlayer && !StateManager.isPerformingEffect()) activePlayer.volume = Math.max(0, Math.min(1, volume));
    },

    setPlaybackMode: (mode: PlaybackMode) => {
      logProbe(`=== 开始执行【模式切换】事务 (请求: ${mode}) ===`, 'group');
      const oldMode = StateManager.getPlaybackMode();
      if (mode === oldMode) {
        logProbe(`[ModeSwitch] 模式未变更 (仍为 ${mode})，事务提前中止。`);
        logProbe('', 'groupEnd');
        return;
      }

      StateManager.setPlaybackMode(mode);
      StrategyManager.setMode(mode);

      logProbe(`[ModeSwitch] 策略已切换为: ${StrategyManager.getCurrentStrategy().constructor.name}`);

      if (oldMode === 'random') {
        logProbe('[ModeSwitch] 正在为旧模式 "random" 执行“离开”生命周期钩子...');
        StateManager.clearRandomModePlan();
      }
      if (mode === 'random') {
        logProbe('[ModeSwitch] 正在为新模式 "random" 执行“进入”生命周期钩子...');
        StrategyManager.notifyQueueChanged();
      }

      void writeState('setPlaybackMode');
      broadcastFullState();
      logProbe('=== 【模式切换】事务执行完毕 ===', 'groupEnd');
    },
    seekTo: (percentage: number) => {
      const activePlayer = PlaybackEngine.getActivePlayer();
      if (activePlayer?.duration) activePlayer.currentTime = activePlayer.duration * percentage;
    },
    getCurrentState: (): FullStatePayload => {
      const i = StateManager.getTopQueueItem();
      const c = i?.playlistContent ?? [];
      const x = i?.currentIndex ?? 0;
      const stateToReturn: FullStatePayload = {
        currentItem: c[x] ? { title: c[x].歌名, artist: c[x].歌手, cover: c[x].封面 } : null,
        isPlaying: StateManager.isPlaying(),
        playbackState: StateManager.getPlaybackState(),
        playbackMode: StateManager.getPlaybackMode(),
        masterVolume: StateManager.getVolume(),
        playlist: c.map(t => ({ title: t.歌名, artist: t.歌手, cover: t.封面 })),
        isTransitioning: StateManager.isPerformingEffect(),
      };
      logProbe('[探针 B] 前端主动调用 getCurrentState 获取初始状态，后台返回的数据如下:', 'warn');
      console.dir(stateToReturn);
      return stateToReturn;
    },

    onFullStateUpdate: (c: (payload: FullStatePayload) => void) => {
      if (typeof c === 'function') {
        fullStateUpdateCallbacks.push(c);
        logProbe(`[API] 前端注册了 fullStateUpdate 监听器。当前监听数: ${fullStateUpdateCallbacks.length}`);

        return () => {
          const index = fullStateUpdateCallbacks.indexOf(c);
          if (index > -1) {
            fullStateUpdateCallbacks.splice(index, 1);
            logProbe(`[API] 前端注销了 fullStateUpdate 监听器。剩余监听数: ${fullStateUpdateCallbacks.length}`);
          }
        };
      }

      return () => {};
    },

    onTimeUpdate: (c: (payload: TimeUpdatePayload) => void) => {
      if (typeof c === 'function') {
        timeUpdateCallbacks.push(c);

        return () => {
          const index = timeUpdateCallbacks.indexOf(c);
          if (index > -1) {
            timeUpdateCallbacks.splice(index, 1);
          }
        };
      }
      return () => {};
    },
  };
  initializeGlobal('musicPlayerAPI', window.musicPlayerAPI);
}

// =================================================================
// 9. 酒馆集成与主执行区 (Tavern Integration & Main Execution)
// =================================================================

function executeHardReset() {
  logProbe('[HardReset] “优雅停机”协议启动...', 'warn');

  isScriptActive = false;

  PlaybackEngine.getActivePlayer()?.pause();
  logProbe('[HardReset] 音频已暂停。');

  logProbe('[HardReset] 即将调用 reloadIframe()。');
  reloadIframe();
}

async function tryInitialize() {
  if (isInitializedForThisChat) return;

  const currentChatId = SillyTavern.getCurrentChatId ? SillyTavern.getCurrentChatId() : null;

  if (SillyTavern.chat.length > 0 && currentChatId !== null) {
    // [原则: SRP] isInitializedForThisChat 标志现在是这个函数的“守卫”，确保初始化只执行一次。
    isInitializedForThisChat = true;
    _currentChatId = currentChatId;

    logProbe(`【初始化指挥官 V9.8】锁定ID: ${_currentChatId}，开始执行“分流-等待-执行”协议...`, 'group');

    try {
      // --- 步骤一：检测 (Detect) ---
      // [原则: SSoT] 初始化流程的第一个动作，就是获取“世界书”这个唯一事实来源。
      const config = await parseWorldbookConfig();
      if (!config) {
        throw new Error('无法解析世界书配置，初始化中止。');
      }

      const isMvuCard = config.isMvu;
      logProbe(`(探针-决策) 作者意图判断 -> 是MVU卡吗? ${isMvuCard}`);

      // --- 步骤二：分流 (Branch) & 等待 (Wait) ---
      if (isMvuCard) {
        logProbe('【指挥官】(路径选择) 检测到MVU卡，进入“安全路径”，开始等待MVU就绪...');
        // [原则: CQS] _waitForMvuGenesis 是一个“查询”，它询问外部环境状态，直到满足条件。
        // 注意: MVU 模式的事件注册 (_registerMvuEventListeners) 是在 _waitForMvuGenesis 内部成功后触发的
        const mvuIsReady = await _waitForMvuGenesis();
        if (!mvuIsReady) {
          throw new Error('MVU集成初始化失败或超时，部分功能将不可用。');
        }
        logProbe('【指挥官】MVU已完全就绪，可以安全继续。');
      } else {
        logProbe('【指挥官】(路径选择) 检测到纯文字卡，进入“快速路径”。');
        _registerTextEventListeners();
      }

      // --- 步骤三：执行 (Execute) ---
      logProbe('【指挥官】所有前置条件满足，开始执行播放器核心初始化...');

      let authoritativeState = null;
      if (isMvuCard) {
        logProbe('【指挥官】(查询) 正在为MVU卡查找权威状态...');
        authoritativeState = await _findLatestAuthoritativeMvuState();
      } else {
        logProbe('【指挥官】(跳过) 纯文字卡，无需查找MVU状态。');
      }

      await initializePlayerForChat(config, authoritativeState);

      _registerContextualEventListeners();

      if (_initializationPromiseControls) {
        logProbe('【指挥官】(探针) 后台初始化成功，兑现 Promise 契约，唤醒前端。');
        _initializationPromiseControls.resolve();
      }
    } catch (error) {
      logProbe(`【指挥官】在初始化主流程中发生严重错误: ${error}`, 'error');
      // 如果发生任何错误，都要通知前端，让它显示错误信息
      if (_initializationPromiseControls) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        _initializationPromiseControls.reject(errorMessage);
      }
    } finally {
      _initializationPromiseControls = null;
      logProbe('【初始化指挥官 V9.8】协议执行完毕。', 'groupEnd');
    }
  }
}

function _registerMvuEventListeners() {
  logProbe('[EventDispatcher] 正在注册【运行时】MVU 事件监听器...');

  const createReconcileHandler = (eventName: string) => {
    return (eventPayload?: any) => {
      if (!isMvuIntegrationActive || !isCorePlayerInitialized) {
        logProbe(`[Gatekeeper] 捕获到MVU事件 (${eventName})，但系统未就绪，已忽略。`, 'warn');
        return;
      }
      logProbe(`[Event] 捕获到MVU事件: ${eventName}，即将唤醒校准官...`);
      // (SSoT原则) 将事件载荷这个“事实”直接传递给校准官
      void _reconcilePlaylistQueue(eventPayload);
    };
  };

  eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, createReconcileHandler('VARIABLE_UPDATE_ENDED'));

  // [已移除] MESSAGE_DELETED 已移动至 _registerContextualEventListeners 以实现通用支持

  logProbe('[EventDispatcher] MVU监听器部署完毕。');
}

/**
 * 注册纯文字模式 ("吟游诗人") 专属的事件监听器。
 * 职责: 监听文本变动事件，并直接呼叫校准官。
 */
function _registerTextEventListeners() {
  logProbe('[EventDispatcher] 正在注册【吟游诗人】文本模式事件监听器...', 'group');

  // 1. 监听 AI 生成完毕 (MESSAGE_RECEIVED)
  eventOn(tavern_events.MESSAGE_RECEIVED, (id: number) => {
    if (!isScriptActive) return;

    logProbe(`[Event] 文本模式捕获到 MESSAGE_RECEIVED (id: ${id})，触发校准...`);
    void _reconcilePlaylistQueue(undefined);
  });

  // 2. 监听 用户编辑消息 (MESSAGE_EDITED)
  eventOn(tavern_events.MESSAGE_EDITED, async (id: number) => {
    if (!isScriptActive) return;

    logProbe(`[Event] 文本模式捕获到 MESSAGE_EDITED (id: ${id})，触发校准与UI补救...`);

    // 第一步：校准播放队列（听觉层）
    await _reconcilePlaylistQueue(undefined);

    // 第二步：如果校准后队列有歌单，确保 UI 标签存在（视觉层）
    await _ensureUiVisibility();
  });

  logProbe('[EventDispatcher] 文本模式监听器部署完毕。', 'groupEnd');
}

/**
 * [V9.1 核心处理器] 统一处理所有导致“运行时历史”变更的事件。
 * 职责：通知校准官进行全量状态同步。
 * @param eventName - 触发此处理器的事件名，用于日志记录。
 */
async function _handleHistoryChangeEvent(eventName: string, options?: { transitionEffect?: 'hard' | 'smooth' }) {
  logProbe(`[HistoryChange] 检测到历史变更事件: ${eventName}。`);
  if (!isCorePlayerInitialized) return;

  if (triggers.length === 0) {
    // 理论上 ParseConfig 阶段会为 Text 模式生成虚拟触发器，所以 triggers 不应为空。
    // 但如果真的为空，说明没有任何音乐配置，直接跳过。
    logProbe('[HistoryChange] (分流) 未检测到任何触发器配置，跳过校准。');
    await _ensureUiVisibility();
    return;
  }

  logProbe(`[HistoryChange] 正在委托校准官进行全量状态校准...`);

  // 校准官内部会根据 isMvuMode 自动决定是查 MVU 还是查 TextTagManager。
  await _reconcilePlaylistQueue(undefined, options);

  await _ensureUiVisibility();
}

/**
 * [V9.9 核心修正] 处理新AI消息渲染事件的专用处理器。
 * (SRP: Single Responsibility Principle)
 * @param messageId - 由事件传来的消息ID。
 */
async function _handleNewAssistantMessage(messageId: number): Promise<void> {
  logProbe(`[Injector] 捕获到 CHARACTER_MESSAGE_RENDERED 事件，message_id: ${messageId}`);

  if (messageId === 0) {
    logProbe(`[Injector] (探针) 操作中止：message_id 为 0 (开场白)，权限属于作者，无需注入。`);
    return;
  }

  const topQueueItem = StateManager.getTopQueueItem();
  if (!topQueueItem) {
    logProbe(`[Injector] (守门员) 拒绝注入：当前播放队列为空。`);
    return;
  }

  try {
    const message = getChatMessages(messageId)?.[0];

    if (message && message.role !== 'user' && !message.message.includes('<DarkBramblePlayer/>')) {
      logProbe(`[Injector] (探针) 条件满足，立即为 message_id: ${messageId} 执行注入...`);

      await setChatMessages([{ message_id: messageId, message: `${message.message}\n<DarkBramblePlayer/>` }]);

      logProbe(`[Injector] (探针) 注入成功。`);
    } else {
      logProbe(`[Injector] (探针) 操作跳过：消息是用户发送的，或已包含标签。Role: ${message?.role}`);
    }
  } catch (error) {
    logProbe(`[Injector] 为 message_id: ${messageId} 注入标签时发生严重错误:`, 'error');
    console.error(error);
  }
}

/**
 * [V9.95 新增] UI 可见性卫士。
 * 职责：在 MVU 延迟加载或消息删除后，确保如果音乐在播放，界面一定存在。
 * 原则：SSoT (以队列状态为准), 鲁棒性 (补救缺失的 UI)
 */
async function _ensureUiVisibility() {
  logProbe('[UiGuard] 正在检查界面一致性 (高性能局部扫描)...', 'groupCollapsed');

  const topQueueItem = StateManager.getTopQueueItem();
  if (!topQueueItem) {
    logProbe('[UiGuard] 队列为空，无需 UI。');
    logProbe('', 'groupEnd');
    return;
  }

  try {
    // [步骤 1] 获取最后一条消息，作为定位锚点
    // 参数 -1 表示获取最新的楼层
    const lastMsgList = getChatMessages(-1);

    if (!lastMsgList || lastMsgList.length === 0) {
      logProbe('[UiGuard] 无法获取最新楼层锚点，检查中止。', 'warn');
      logProbe('', 'groupEnd');
      return;
    }

    // [步骤 2] 计算最近 10 楼的 ID 范围
    // 假设最后一条 ID 是 100，我们想要 91-100 (共10条)
    const lastId = lastMsgList[0].message_id;
    // 使用 Math.max 确保不会算出负数 ID
    const startId = Math.max(0, lastId - 9);
    const rangeString = `${startId}-${lastId}`;

    logProbe(`[UiGuard] 正在获取最近的 10 条消息 (ID范围: ${rangeString})...`);

    // [步骤 3] 仅拉取这 10 条数据
    // 接口支持 "StartID-EndID" 格式的字符串
    const recentMessages = getChatMessages(rangeString);

    if (!recentMessages || recentMessages.length === 0) {
      logProbe('[UiGuard] 局部消息拉取为空，检查中止。', 'warn');
      logProbe('', 'groupEnd');
      return;
    }

    let foundTarget = false;

    // [步骤 4] 倒序扫描这 10 条数据
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];

      // 1. 跳过用户消息
      if (msg.role === 'user') {
        continue;
      }

      // 2. 遇到开场白停止 (尊重作者排版)
      if (msg.message_id === 0) {
        logProbe('[UiGuard] 回溯至开场白，停止。');
        break;
      }

      // 3. 检查是否已有标签
      if (msg.message && msg.message.includes('<DarkBramblePlayer/>')) {
        logProbe(`[UiGuard] 在 message_id: ${msg.message_id} 处发现已有标签，状态正常。`);
        foundTarget = true;
        break;
      }

      // 4. 执行注入
      logProbe(`[UiGuard] 发现目标宿主: message_id: ${msg.message_id} (${msg.role})，执行补救注入...`);
      const newContent = `${msg.message}\n<DarkBramblePlayer/>`;

      await setChatMessages([
        {
          message_id: msg.message_id,
          message: newContent,
        },
      ]);

      logProbe('[UiGuard] 补救注入成功。');
      foundTarget = true;
      break;
    }

    if (!foundTarget) {
      logProbe('[UiGuard] 在最近 10 条消息中未发现合适的注入点。');
    }
  } catch (error) {
    logProbe(`[UiGuard] 执行补救注入时发生错误: ${error}`, 'error');
  } finally {
    logProbe('', 'groupEnd');
  }
}

/**
 * [V9.0 核心] 执行一次“软重置”。
 * 这将在不刷新整个页面的情况下，重新执行完整的初始化流程。
 * 用于响应“开场白滑动”等根本性的上下文变更。
 */
async function _executeSoftReset(options?: { autoPlayIfWasPlaying?: boolean }) {
  logProbe('[SoftReset] 检测到根本性上下文变更，启动“软重置”协议...', 'warn');
  try {
    const config = await parseWorldbookConfig();

    logProbe('[SoftReset] 正在为新的开场白查找权威MVU状态...');
    const authoritativeState = await _findLatestAuthoritativeMvuState();

    await initializePlayerForChat(config, authoritativeState, options);
  } catch (error) {
    logProbe('[SoftReset] 软重置过程中发生严重错误。', 'error');
    console.error(error);
  }
}

/**
 * [V9.9 原始数据卫士] (Raw Data Guard)
 * 职责 (Query): 直接穿透封装层，检查酒馆内存中指定消息的内容是否已就绪。
 * 这是区分 "浏览历史" (内容已存在) 和 "触发生成" (内容为空) 的唯一事实来源。
 */
function _isSwipeContentReady(messageId: number): boolean {
  // 1. 安全获取上下文
  // [修复] 必须通过 window.parent 才能在 iframe 中访问到酒馆的真实数据
  const context = (window.parent as any).SillyTavern?.getContext?.();

  if (!context || !context.chat) {
    // 极罕见情况：如果上下文不存在，为安全起见视为未就绪
    return false;
  }

  // 2. 获取消息对象
  const msg = context.chat[messageId];
  if (!msg) return false;

  // 3. 获取指针和数据槽
  const pointer = msg.swipe_id;
  const swipes = msg.swipes;

  // 4. 核心判定：必须是字符串且长度大于0
  if (Array.isArray(swipes) && typeof pointer === 'number') {
    const content = swipes[pointer];
    // 只有当内容是实实在在的字符串，且不是空串时，才视为历史记录
    return typeof content === 'string' && content.length > 0;
  }

  return false;
}

function _registerContextualEventListeners() {
  logProbe('[EventDispatcher] 正在注册“上下文专属”事件监听器...');

  eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, (id: number) => {
    if (!isScriptActive) return;
    void _handleNewAssistantMessage(id);
  });

  eventOn(tavern_events.MESSAGE_DELETED, (deletedId: number) => {
    if (!isScriptActive) return;
    logProbe(`[EventAdapter] 捕获到删除事件 (原ID: ${deletedId})，正在通过“高级历史通道”触发全量校准...`);
    void _handleHistoryChangeEvent('MESSAGE_DELETED');
  });

  eventOn(tavern_events.MESSAGE_SWIPED, (id: number) => {
    if (!isScriptActive) return;

    // 原始数据卫士 (Raw Data Guard)
    // 目的: 区分 "浏览历史Swipe" 和 "触发生成Swipe"
    // 原理: 直接检查内存。如果内容为空，说明是生成行为，必须拦截。
    if (!_isSwipeContentReady(id)) {
      logProbe(
        `[Event-Swipe] (卫士) 拦截生效！检测到 message_id: ${id} 的内容尚未填充 (生成中/空内容)，忽略本次操作。`,
        'warn',
      );
      return;
    }

    logProbe(`[Event] 捕获到滑动事件 (message_id: ${id})。卫士已放行 (内容已就绪)。`);
    if (!isCorePlayerInitialized) return;

    if (id === 0) {
      logProbe('[Event-Swipe] 判断为开场白滑动，执行软重置...');
      const wasPlaying = StateManager.isPlaying();
      logProbe(`[Event-Swipe] (探针) 软重置前的播放状态: ${wasPlaying}`);
      void _executeSoftReset({ autoPlayIfWasPlaying: wasPlaying });
    } else {
      logProbe('[Event-Swipe] 判断为历史消息滑动，执行历史变更处理...');
      void _handleHistoryChangeEvent('MESSAGE_SWIPED', { transitionEffect: 'hard' });
    }
  });

  logProbe('[EventDispatcher] “上下文专属”事件监听器注册完毕。');
}

/**
 * [原则: SRP] 这个函数的单一职责是：作为一个返回 Promise 的“观察哨”，
 * 它只负责“等待MVU创世完成”这一件事。成功则 resolve(true)，失败或超时则 resolve(false)。
 * 所有后续操作（如注册事件）都作为成功后的“副作用”在内部执行。
 */
async function _waitForMvuGenesis(): Promise<boolean> {
  logProbe('【安全观察哨】已上岗，开始执行MVU就绪检查...', 'group');

  try {
    // [探针] 阶段一：等待 MVU 框架本身出现
    await waitGlobalInitialized('Mvu');
    logProbe('【观察哨】(探针) 阶段一成功：MVU 框架已加载。');
  } catch (e) {
    logProbe(`【观察哨】(探针) 阶段一失败: ${e}。`, 'warn');
    logProbe('【安全观察哨】任务失败。', 'groupEnd');
    return false;
  }

  // [探针] 阶段二：轮询观察，等待 MVU 将初始数据写入消息楼层
  const WATCHER_TIMEOUT = 10000;
  const WATCHER_INTERVAL = 250;
  const startTime = Date.now();
  let isGenesisComplete = false;

  logProbe('【观察哨】(探针) 阶段二开始：正在严密监视 message_id: 0 的创世数据...');
  while (Date.now() - startTime < WATCHER_TIMEOUT) {
    try {
      const mvuData: any = await Mvu.getMvuData({ type: 'message', message_id: 0 });
      if (mvuData && (mvuData.swipes_data || mvuData.stat_data)) {
        logProbe('【观察哨】(探针) 阶段二成功：在消息楼层中确认到创世数据！');
        isGenesisComplete = true;
        break;
      }
    } catch (error) {
      /* 在MVU启动初期，查询失败是正常现象，静默处理 */
    }
    await new Promise(resolve => setTimeout(resolve, WATCHER_INTERVAL));
  }

  if (!isGenesisComplete) {
    logProbe('【观察哨】(探针) 阶段二失败：观察超时！', 'error');
    logProbe('【安全观察哨】任务失败。', 'groupEnd');
    return false;
  }

  // [探针] 阶段三：所有条件满足，执行激活序列
  logProbe('【观察哨】(探针) 阶段三开始：执行MVU集成激活序列...');
  try {
    _registerMvuEventListeners();
    isMvuIntegrationActive = true;
    logProbe('【观察哨】(探针) 阶段三成功：MVU集成已完全激活。');
    logProbe('【安全观察哨】任务成功完成！', 'groupEnd');
    return true;
  } catch (error) {
    logProbe(`【观察哨】(探针) 阶段三失败：激活序列发生意外崩溃: ${error}`, 'error');
    isMvuIntegrationActive = false;
    logProbe('【安全观察哨】任务失败。', 'groupEnd');
    return false;
  }
}

$(() => {
  PlaybackEngine.initialize();
  setupGlobalAPI();

  eventOn(tavern_events.CHAT_CHANGED, () => {
    logProbe(`[硬重置] CHAT_CHANGED 事件触发，检测到聊天上下文变更。即将执行“优雅停机”协议。`, 'warn');
    executeHardReset();
  });

  const observerInterval = setInterval(() => {
    void tryInitialize();
    if (isInitializedForThisChat) {
      clearInterval(observerInterval);
      logProbe('【观察者模型】初始化成功，观察者已销毁。');
    }
  }, 250);

  setTimeout(() => {
    if (!isInitializedForThisChat) {
      clearInterval(observerInterval);
      logProbe('【观察者模型】初始化超时！', 'error');

      if (_initializationPromiseControls) {
        _initializationPromiseControls.reject('Initialization timed out after 10 seconds.');
        _initializationPromiseControls = null;
      }
    }
  }, 10000);

  $(window).on('pagehide', () => {
    logProbe('PAGEHIDE 事件触发！', 'warn');

    PlaybackEngine.getActivePlayer()?.pause();
    logProbe('音频已暂停。');
  });
});
