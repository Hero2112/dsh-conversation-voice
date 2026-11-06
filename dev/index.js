/**
 * conversation-voice 插件的 Host 半。
 *
 * 作用：每一轮对话结束（`turn/end`）后，先响一声系统提示音，再用 Windows 自带的
 * SAPI 语音朗读这一轮「最终答复」的摘要，让人离开屏幕也知道任务做完了什么。
 *
 * 为什么放在 Host 侧：浏览器标签页可能被切走、窗口失焦，页面里的 Web Audio 会被
 * 浏览器静音或暂停；Host 侧的 PowerShell 进程不受这些限制，提示音和语音都能正常出声。
 *
 * 实现要点：
 * 1. 只监听 `session/event`，在 `turn/end` 且 reason 为正常完成时才播报；
 * 2. 摘要取自 `session.deriveMessages()` 里最后一条 assistant 文字消息；
 * 3. 语音通过 `spawn` 拉起 `powershell.exe -EncodedCommand`，文本以 Base64 传入，
 *    彻底避开引号、换行、中文编码这些坑；
 * 4. 播报串行排队，同一时间只响一个；新一轮开始时取消还没播的旧摘要。
 */
import { spawn } from 'node:child_process';

/** 插件标识，日志里用得到。 */
const TAG = '[conversation-voice]';

/** 默认配置（对应 cordis 行里的 config 字段，缺省即用这些值）。 */
export const DEFAULTS = Object.freeze({
  /** 总开关。 */
  enabled: true,
  /** 是否先响一声系统提示音。 */
  chime: true,
  /** 提示音用哪个 Windows 系统声音：Asterisk / Beep / Exclamation / Hand / Question。 */
  chimeSound: 'Asterisk',
  /** 是否朗读摘要。关掉就只剩提示音。 */
  speech: true,
  /** 指定发音人名称；留空表示自动挑中文语音。 */
  voice: '',
  /** 语速，-10（最慢）到 10（最快）。 */
  rate: 0,
  /** 音量，0 到 100。 */
  volume: 95,
  /** 朗读摘要最多保留多少字。 */
  maxChars: 120,
  /** 朗读前缀，例如「任务完成。」。 */
  prefix: '任务完成。',
  /** 回合结束后等多久再播报（毫秒），用来合并连续触发的回合。 */
  debounceMs: 900,
  /** 是否跳过子代理会话（子代理的回合不播报，免得吵）。 */
  skipSubagent: true,
  /** 是否只在正常完成时播报（aborted / error / blocked 不播）。 */
  onlyCompleted: true,
});

/** 支持的 Windows 系统声音。 */
export const CHIME_SOUNDS = Object.freeze(['Asterisk', 'Beep', 'Exclamation', 'Hand', 'Question']);

/** 句子结束标点，用于把截断的摘要收在标点处。 */
const SENTENCE_END = ['。', '！', '？', '；', '：', '.', '!', '?', ';'];

/** 提示音之后的停顿（毫秒），免得人声压住提示音。 */
const CHIME_GAP_MS = 280;

/** 单次播报的最长存活时间（毫秒）；PowerShell 卡死时兜底杀掉。 */
const SPEECH_WATCHDOG_MS = 60000;

/**
 * 读一个数字并夹到区间内，非法值回退默认值。
 * @param value 原始值
 * @param min 下限
 * @param max 上限
 * @param fallback 默认值
 * @returns 夹紧后的整数
 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * 把行里的 config 归一化成一份完整、类型正确的配置。
 * @param input 原始 config（可能是空对象）
 * @returns 归一化后的配置
 */
export function normalizeConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const chimeSound = typeof source.chimeSound === 'string' && CHIME_SOUNDS.indexOf(source.chimeSound) >= 0
    ? source.chimeSound
    : DEFAULTS.chimeSound;
  const voice = typeof source.voice === 'string' ? source.voice.trim() : DEFAULTS.voice;
  const prefix = typeof source.prefix === 'string' ? source.prefix : DEFAULTS.prefix;
  return {
    enabled: source.enabled === undefined ? DEFAULTS.enabled : Boolean(source.enabled),
    chime: source.chime === undefined ? DEFAULTS.chime : Boolean(source.chime),
    chimeSound,
    speech: source.speech === undefined ? DEFAULTS.speech : Boolean(source.speech),
    voice,
    rate: clampInt(source.rate, -10, 10, DEFAULTS.rate),
    volume: clampInt(source.volume, 0, 100, DEFAULTS.volume),
    maxChars: clampInt(source.maxChars, 20, 500, DEFAULTS.maxChars),
    prefix,
    debounceMs: clampInt(source.debounceMs, 0, 10000, DEFAULTS.debounceMs),
    skipSubagent: source.skipSubagent === undefined ? DEFAULTS.skipSubagent : Boolean(source.skipSubagent),
    onlyCompleted: source.onlyCompleted === undefined ? DEFAULTS.onlyCompleted : Boolean(source.onlyCompleted),
  };
}

/**
 * 把 Markdown 答复清成适合朗读的纯文本。
 * 代码块整段丢掉（念出来没意义），链接保留文字，表格转成空格分隔。
 * @param input 原始 Markdown
 * @returns 可朗读的纯文本
 */
export function cleanForSpeech(input) {
  if (typeof input !== 'string' || input === '') return '';
  let text = input.replace(/\r\n?/g, '\n');
  // 围栏代码块（含未闭合的）
  text = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  // 行内代码：保留内容
  text = text.replace(/`([^`\n]*)`/g, '$1');
  // 图片 -> 去掉；链接 -> 保留文字
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 行内 HTML
  text = text.replace(/<[^>]*>/g, ' ');
  // 表格分隔行
  text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ');
  // 标题、引用、列表符号、分隔线
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ');
  // 强调符号
  text = text.replace(/[*_~]{1,3}/g, '');
  // 表格竖线
  text = text.replace(/\|/g, ' ');
  // 表情符号（TTS 念不出来，还会打断节奏）
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  // 控制字符
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  // 空白折叠
  text = text.replace(/\s+/g, ' ').trim();
  // 只剩标点或分隔符时当作没有内容
  if (/^[\s。，、；：！？.,;:!?\-—_~]+$/.test(text)) return '';
  return text;
}

/**
 * 把答复压成一段适合朗读的短句：清洗 + 截断 + 收尾标点。
 * @param input 原始 Markdown
 * @param maxChars 最大字数
 * @returns 可直接朗读的摘要
 */
export function summarizeForSpeech(input, maxChars) {
  const cleaned = cleanForSpeech(input);
  const limit = clampInt(maxChars, 20, 500, DEFAULTS.maxChars);
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit);
  // 尽量切在标点处，避免半个词
  let best = -1;
  for (const punctuation of SENTENCE_END) {
    const index = cut.lastIndexOf(punctuation);
    if (index > best) best = index;
  }
  const body = best >= Math.floor(limit * 0.6) ? cut.slice(0, best + 1) : cut;
  if (best >= Math.floor(limit * 0.6) && SENTENCE_END.indexOf(body.slice(-1)) >= 0) return body;
  return body.replace(/[\s，、；：,;:]+$/u, '') + '。';
}

/**
 * 从会话里取最后一条 assistant 文字消息（只在本轮范围内找）。
 * @param session dsh-session 的 Session 实例
 * @returns 原始 Markdown 文本，取不到返回空串
 */
export function lastAssistantText(session) {
  if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
  let messages;
  try {
    messages = session.deriveMessages();
  } catch (error) {
    return '';
  }
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // 只看最后一条 user 消息之后的 assistant 消息，避免念到上一轮的旧答复
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message !== null && typeof message === 'object' && message.role === 'user') {
      start = index + 1;
      break;
    }
  }
  for (let index = messages.length - 1; index >= start; index--) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
    const text = textOfContent(message.content);
    if (text !== '') return text;
  }
  return '';
}

/**
 * 取一条消息 content 里的文字部分。
 * @param content 字符串或 AI SDK 的 content 块数组
 * @returns 拼起来的文字
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join(' ').trim();
}

/**
 * 判断一个会话是不是子代理会话。
 * @param session Session 实例
 * @returns 有 parentSession 头信息就算子代理
 */
export function isSubagentSession(session) {
  const header = session !== null && session !== undefined && typeof session === 'object' ? session.header : undefined;
  if (header === null || header === undefined || typeof header !== 'object') return false;
  return typeof header.parentSession === 'string' && header.parentSession !== '';
}

/**
 * 拼出真正要念的那句话。
 * @param config 归一化配置
 * @param summary 摘要文本（可为空）
 * @returns 完整播报文本
 */
export function composeAnnouncement(config, summary) {
  const prefix = typeof config.prefix === 'string' ? config.prefix : '';
  if (summary === '' || summary === undefined || summary === null) return prefix;
  return prefix + summary;
}

/**
 * 生成要交给 PowerShell 的脚本。
 * 文本走 Base64，避免引号/换行/中文编码问题。
 * @param config 归一化配置
 * @param announcement 要朗读的文本
 * @returns PowerShell 脚本文本
 */
export function buildScript(config, announcement) {
  const textBase64 = Buffer.from(String(announcement), 'utf8').toString('base64');
  const voice = String(config.voice || '').replace(/'/g, "''");
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (config.chime) {
    lines.push(`[System.Media.SystemSounds]::${config.chimeSound}.Play()`);
    lines.push(`Start-Sleep -Milliseconds ${CHIME_GAP_MS}`);
  }
  if (config.speech) {
    lines.push('Add-Type -AssemblyName System.Speech');
    lines.push(`$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textBase64}'))`);
    lines.push('$s = New-Object System.Speech.Synthesis.SpeechSynthesizer');
    lines.push('$chosen = $null');
    lines.push('$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })');
    if (voice !== '') {
      lines.push(`$chosen = $voices | Where-Object { $_.VoiceInfo.Name -eq '${voice}' } | Select-Object -First 1`);
    } else {
      lines.push("$chosen = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1");
    }
    lines.push('if ($chosen -ne $null) { $s.SelectVoice($chosen.VoiceInfo.Name) }');
    lines.push(`$s.Rate = ${config.rate}`);
    lines.push(`$s.Volume = ${config.volume}`);
    lines.push('$s.Speak($text)');
    lines.push('$s.Dispose()');
  }
  return lines.join('\n');
}

/**
 * 把脚本文本编码成 `-EncodedCommand` 需要的 Base64（UTF-16LE）。
 * @param script PowerShell 脚本
 * @returns Base64 字符串
 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 定位 Windows PowerShell 5.1（不能用 pwsh：System.Speech 在 PowerShell 7 里不可用）。
 * @param env 环境变量对象
 * @returns 可执行文件路径或命令名
 */
export function powershellPath(env = process.env) {
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot !== ''
    ? env.SystemRoot
    : typeof env.windir === 'string' && env.windir !== ''
      ? env.windir
      : 'C:\\Windows';
  const full = root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return full;
}

/**
 * 拼出拉起 PowerShell 的完整参数表。
 * @param config 归一化配置
 * @param announcement 播报文本
 * @param env 环境变量
 * @returns `{ command, args }` 或 null（非 Windows）
 */
export function buildSpeechCommand(config, announcement, env = process.env) {
  if (process.platform !== 'win32') return null;
  return {
    command: powershellPath(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeCommand(buildScript(config, announcement)),
    ],
  };
}

/** 测试用的 spawn 替身；生产环境恒为 undefined。 */
let spawnOverride;

/**
 * 只给测试用：替换真正拉起进程的函数。
 * @param implementation 替身函数；传 undefined 恢复默认
 */
export function setSpawnForTest(implementation) {
  spawnOverride = implementation;
}

/**
 * 打印一条警告（插件出错不能影响正常对话）。
 * @param message 说明
 * @param error 原始错误
 */
function warn(message, error) {
  const detail = error !== undefined && error !== null && typeof error.message === 'string' ? '：' + error.message : '';
  console.warn(TAG + ' ' + message + detail);
}

/**
 * 播报器：串行排队，同一时间只响一个；新摘要比旧摘要重要，排队时只保留最新。
 * @param config 归一化配置
 * @param spawnFn 拉起进程的函数
 * @returns `{ say, dispose, playing }`
 */
export function createSpeaker(config, spawnFn = (command, args, options) => (spawnOverride ?? spawn)(command, args, options)) {
  let queued = null;
  let busy = false;
  let disposed = false;
  let child = null;
  let watchdog = null;

  /** 跑一条播报，返回 Promise，进程退出或失败时结束。 */
  function run(announcement) {
    return new Promise((resolve) => {
      const command = buildSpeechCommand(config, announcement);
      if (command === null) {
        resolve();
        return;
      }
      let settled = false;
      /** 结束一次播报，重复调用无副作用。 */
      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        child = null;
        resolve();
      };
      try {
        child = spawnFn(command.command, command.args, { windowsHide: true, stdio: 'ignore' });
      } catch (error) {
        warn('拉起语音进程失败', error);
        finish();
        return;
      }
      if (child === null || child === undefined || typeof child.once !== 'function') {
        finish();
        return;
      }
      child.once('error', (error) => {
        warn('语音进程出错', error);
        finish();
      });
      child.once('exit', finish);
      watchdog = setTimeout(() => {
        try {
          if (child !== null && typeof child.kill === 'function') child.kill();
        } catch (error) {
          /* 进程已经没了就算了 */
        }
        finish();
      }, SPEECH_WATCHDOG_MS);
      if (typeof watchdog.unref === 'function') watchdog.unref();
    });
  }

  /** 依次消费排队里的摘要。 */
  async function pump() {
    if (busy || disposed) return;
    busy = true;
    try {
      while (queued !== null && !disposed) {
        const announcement = queued;
        queued = null;
        await run(announcement);
      }
    } finally {
      busy = false;
    }
  }

  return {
    /** 排队播报一段文本（排队只保留最新一条）。 */
    say(announcement) {
      if (disposed) return;
      queued = announcement;
      void pump();
    },
    /** 是否正在出声。 */
    get playing() {
      return busy;
    },
    /** 插件卸载时收尾：停掉排队和正在播放的进程。 */
    dispose() {
      disposed = true;
      queued = null;
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      try {
        if (child !== null && typeof child.kill === 'function') child.kill();
      } catch (error) {
        /* 进程已经没了就算了 */
      }
      child = null;
    },
  };
}

/**
 * 判断一个 `turn/end` 是否应该播报。
 * @param config 归一化配置
 * @param session 会话
 * @param event 会话事件
 * @returns 需要播报时返回 true
 */
export function shouldAnnounce(config, session, event) {
  if (!config.enabled) return false;
  if (event === null || event === undefined || typeof event !== 'object') return false;
  if (event.type !== 'turn/end') return false;
  if (config.skipSubagent && isSubagentSession(session)) return false;
  if (!config.onlyCompleted) return true;
  const reason = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data.reason : undefined;
  const kind = reason !== null && reason !== undefined && typeof reason === 'object' ? reason.kind : undefined;
  return kind === 'completed' || kind === 'max-tokens';
}

/**
 * 插件入口。
 * @param ctx cordis 上下文
 * @param rawConfig 行里的 config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const speaker = createSpeaker(config);

  /** 每个会话一条待播定时器：新一轮开始时可以取消。 */
  const timers = new Map();

  /**
   * 安排一次播报；同一会话再次触发时替换掉还没播的旧摘要。
   * @param sessionId 会话 id
   * @param summary 摘要文本
   */
  function schedule(sessionId, summary) {
    const previous = timers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const announcement = composeAnnouncement(config, summary);
    if (announcement === '' && !config.chime) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      speaker.say(announcement);
    }, config.debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(sessionId, timer);
  }

  /** 取消某会话还没播的摘要。 */
  function cancel(sessionId) {
    const timer = timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event === null || event === undefined || typeof event !== 'object') return;
      const sessionId = session !== null && session !== undefined && typeof session === 'object' ? session.id : undefined;
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (event.type === 'turn/start') {
        // 新一轮开始：上一轮还没出声的摘要就过时了
        cancel(sessionId);
        return;
      }
      if (!shouldAnnounce(config, session, event)) return;
      const summary = summarizeForSpeech(lastAssistantText(session), config.maxChars);
      schedule(sessionId, summary);
    } catch (error) {
      warn('处理会话事件失败', error);
    }
  });

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    speaker.dispose();
  }, 'conversation-voice: 播报器收尾');

  console.info(TAG + ' 已加载：对话回合结束后播放提示音并朗读摘要');
}
