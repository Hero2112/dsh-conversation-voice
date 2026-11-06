#!/usr/bin/env node
/**
 * conversation-voice 的行为冒烟测试。
 * 不启动 DSH、不真的出声：用假 ctx 和假 spawn 验证「事件 -> 摘要 -> 命令」整条链路。
 * 用法：node tests/run.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ENTRY = pathToFileURL(path.join(__dirname, '..', 'dev', 'index.js')).href;

/** 等一会儿，给定时器/回调留出时间。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 伪造一个 cordis 上下文，只实现插件用到的 on / effect。
 * @returns 可触发事件的测试夹具
 */
function fakeContext() {
  const listeners = new Map();
  const cleanups = [];
  return {
    ctx: {
      on(name, handler) {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
        return () => set.delete(handler);
      },
      effect(factory) {
        const cleanup = factory();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
        return cleanup;
      },
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    listenerCount(name) {
      return (listeners.get(name) ?? new Set()).size;
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/**
 * 伪造 spawn：记录调用，并在极短时间内假装进程退出。
 * @param calls 记录每次调用的数组
 * @returns spawn 替身
 */
function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      once(event, callback) {
        if (event === 'exit') setTimeout(callback, 2);
      },
      kill() {
        /* 假进程不需要真的杀 */
      },
    };
  };
}

/** 造一个带一轮对话的假会话。 */
function fakeSession(options = {}) {
  return {
    id: options.id ?? 'session-1',
    header: options.header ?? { version: 4, id: options.id ?? 'session-1', createdAt: 0, isSeeded: false },
    deriveMessages() {
      return options.messages ?? [
        { role: 'user', content: [{ type: 'text', text: '帮我做三行表格' }] },
        { role: 'assistant', content: [{ type: 'text', text: '已完成，共 3 行。' }] },
      ];
    },
  };
}

(async () => {
  const plugin = await import(ENTRY);
  const results = [];
  let passed = 0;

  /**
   * 跑一条测试。
   * @param name 测试名
   * @param fn 测试体
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      results.push({ ok: true, name });
      console.log('  ok  ' + name);
    } catch (error) {
      results.push({ ok: false, name, error });
      console.log('FAIL  ' + name + '\n      ' + (error && error.message ? error.message : error));
    }
  }

  // ---------------------------------------------------------------- 纯函数
  await test('默认配置齐全且类型正确', () => {
    const config = plugin.normalizeConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.chime, true);
    assert.equal(config.chimeSound, 'Asterisk');
    assert.equal(config.speech, true);
    assert.equal(config.voice, '');
    assert.equal(config.rate, 0);
    assert.equal(config.volume, 95);
    assert.equal(config.maxChars, 120);
    assert.equal(config.prefix, '任务完成。');
    assert.equal(config.debounceMs, 900);
  });

  await test('非法配置被夹紧或回退', () => {
    const config = plugin.normalizeConfig({
      rate: 99,
      volume: -3,
      maxChars: 1,
      debounceMs: 999999,
      chimeSound: 'NoSuchSound',
    });
    assert.equal(config.rate, 10);
    assert.equal(config.volume, 0);
    assert.equal(config.maxChars, 20);
    assert.equal(config.debounceMs, 10000);
    assert.equal(config.chimeSound, 'Asterisk');
  });

  await test('清洗 Markdown：去代码块、去标记、去表情', () => {
    const cleaned = plugin.cleanForSpeech([
      '## 已完成',
      '',
      '处理了 **三件事**：',
      '',
      '```js',
      'console.log("不要念我")',
      '```',
      '',
      '- 第一个',
      '- 第二个 🔥',
      '',
      '参考[文档](https://example.com)。',
    ].join('\n'));
    assert.ok(cleaned.indexOf('已完成') >= 0, cleaned);
    assert.ok(cleaned.indexOf('三件事') >= 0, cleaned);
    assert.ok(cleaned.indexOf('第一个') >= 0, cleaned);
    assert.ok(cleaned.indexOf('不要念我') < 0, cleaned);
    assert.ok(cleaned.indexOf('文档') >= 0, cleaned);
    assert.ok(cleaned.indexOf('https://') < 0, cleaned);
    assert.ok(cleaned.indexOf('**') < 0, cleaned);
    assert.ok(!/[\u{1F000}-\u{1FAFF}]/u.test(cleaned), cleaned);
  });

  await test('摘要按字数截断并收在标点处', () => {
    const long = '第一段说完了。' + '第二段'.repeat(200);
    const summary = plugin.summarizeForSpeech(long, 40);
    assert.ok(summary.length <= 41, String(summary.length));
    assert.ok(summary.endsWith('。'), summary);
  });

  await test('摘要不会超过上限太多', () => {
    const summary = plugin.summarizeForSpeech('啊'.repeat(300), 50);
    assert.ok(summary.length <= 52, String(summary.length));
  });

  await test('取最后一条 assistant 文字消息', () => {
    const session = fakeSession({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
        { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
        { role: 'user', content: [{ type: 'text', text: '新问题' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'x' }] },
        { role: 'assistant', content: [{ type: 'text', text: '新回答' }] },
      ],
    });
    assert.equal(plugin.lastAssistantText(session), '新回答');
  });

  await test('跳过只有工具调用的最后一条，回退到本轮带文字的消息', () => {
    const session = fakeSession({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '问题' }] },
        { role: 'assistant', content: [{ type: 'text', text: '中间结论' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'x' }] },
      ],
    });
    assert.equal(plugin.lastAssistantText(session), '中间结论');
  });

  await test('没有 assistant 消息时返回空串', () => {
    assert.equal(plugin.lastAssistantText(fakeSession({ messages: [] })), '');
  });

  await test('内容块数组取文字，忽略推理与工具块', () => {
    assert.equal(
      plugin.textOfContent([
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: '正文' },
        { type: 'tool-call', toolName: 'x' },
      ]),
      '正文',
    );
    assert.equal(plugin.textOfContent('直接字符串'), '直接字符串');
    assert.equal(plugin.textOfContent(undefined), '');
  });

  await test('识别子代理会话', () => {
    assert.equal(plugin.isSubagentSession(fakeSession()), false);
    assert.equal(plugin.isSubagentSession(fakeSession({ header: { parentSession: 'p1' } })), true);
  });

  await test('播报文本 = 前缀 + 摘要', () => {
    const config = plugin.normalizeConfig({});
    assert.equal(plugin.composeAnnouncement(config, '做完了。'), '任务完成。做完了。');
    assert.equal(plugin.composeAnnouncement(config, ''), '任务完成。');
  });

  await test('PowerShell 脚本包含提示音、语音与 Base64 文本', () => {
    const config = plugin.normalizeConfig({});
    const script = plugin.buildScript(config, '任务完成。做完了。');
    assert.ok(script.indexOf('[System.Media.SystemSounds]::Asterisk.Play()') >= 0, script);
    assert.ok(script.indexOf('Add-Type -AssemblyName System.Speech') >= 0, script);
    assert.ok(script.indexOf("Culture.Name -like 'zh*'") >= 0, script);
    assert.ok(script.indexOf('$s.Rate = 0') >= 0, script);
    assert.ok(script.indexOf('$s.Volume = 95') >= 0, script);
    const expected = Buffer.from('任务完成。做完了。', 'utf8').toString('base64');
    assert.ok(script.indexOf(expected) >= 0, script);
  });

  await test('关掉语音后脚本只剩提示音', () => {
    const config = plugin.normalizeConfig({ speech: false });
    const script = plugin.buildScript(config, 'x');
    assert.ok(script.indexOf('System.Media.SystemSounds') >= 0, script);
    assert.ok(script.indexOf('Add-Type') < 0, script);
  });

  await test('关掉提示音后脚本只剩语音', () => {
    const config = plugin.normalizeConfig({ chime: false });
    const script = plugin.buildScript(config, '任务完成。');
    assert.ok(script.indexOf('SystemSounds') < 0, script);
    assert.ok(script.indexOf('Add-Type') >= 0, script);
  });

  await test('指定发音人时脚本按名称挑', () => {
    const config = plugin.normalizeConfig({ voice: 'Microsoft Huihui Desktop' });
    const script = plugin.buildScript(config, 'x');
    assert.ok(script.indexOf("VoiceInfo.Name -eq 'Microsoft Huihui Desktop'") >= 0, script);
    assert.ok(script.indexOf("Culture.Name -like 'zh*'") < 0, script);
  });

  await test('-EncodedCommand 能还原出原脚本', () => {
    const config = plugin.normalizeConfig({});
    const script = plugin.buildScript(config, '任务完成。还原测试。');
    const encoded = plugin.encodeCommand(script);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
  });

  await test('Windows 命令参数完整且结尾是 -EncodedCommand', () => {
    const config = plugin.normalizeConfig({});
    const command = plugin.buildSpeechCommand(config, '任务完成。');
    assert.ok(command !== null, '应当返回命令');
    assert.ok(/powershell\.exe$/i.test(command.command), command.command);
    assert.deepEqual(command.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass']);
    assert.equal(command.args[6], '-EncodedCommand');
    assert.ok(command.args[7].length > 0);
  });

  await test('判断哪些回合结束要播报', () => {
    const config = plugin.normalizeConfig({});
    const session = fakeSession();
    assert.equal(plugin.shouldAnnounce(config, session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }), true);
    assert.equal(plugin.shouldAnnounce(config, session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), true);
    assert.equal(plugin.shouldAnnounce(config, session, { type: 'turn/end', data: { reason: { kind: 'error' } } }), false);
    assert.equal(plugin.shouldAnnounce(config, session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }), false);
    assert.equal(plugin.shouldAnnounce(config, session, { type: 'turn/start' }), false);
    assert.equal(plugin.shouldAnnounce(plugin.normalizeConfig({ enabled: false }), session, {
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    }), false);
    const child = fakeSession({ header: { parentSession: 'p1' } });
    assert.equal(plugin.shouldAnnounce(config, child, { type: 'turn/end', data: { reason: { kind: 'completed' } } }), false);
  });

  // ---------------------------------------------------------------- 事件链路
  await test('回合结束触发一次播报，念的是本轮答复', async () => {
    const calls = [];
    plugin.setSpawnForTest(fakeSpawn(calls));
    const harness = fakeContext();
    plugin.apply(harness.ctx, { debounceMs: 0 });
    try {
      assert.equal(harness.listenerCount('session/event'), 1);
      harness.emit('session/event', fakeSession(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      await sleep(60);
      assert.equal(calls.length, 1, '应当只播报一次');
      const script = Buffer.from(calls[0].args[calls[0].args.length - 1], 'base64').toString('utf16le');
      assert.ok(script.indexOf(Buffer.from('任务完成。', 'utf8').toString('base64')) >= 0, script);
      assert.ok(script.indexOf(Buffer.from('已完成，共 3 行。', 'utf8').toString('base64')) >= 0, script);
    } finally {
      harness.dispose();
      plugin.setSpawnForTest(undefined);
    }
  });

  await test('新一轮开始会取消还没播的上一轮', async () => {
    const calls = [];
    plugin.setSpawnForTest(fakeSpawn(calls));
    const harness = fakeContext();
    plugin.apply(harness.ctx, { debounceMs: 120 });
    try {
      harness.emit('session/event', fakeSession(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      await sleep(20);
      harness.emit('session/event', fakeSession(), { type: 'turn/start', data: { turn: 2 } });
      await sleep(150);
      assert.equal(calls.length, 0, '取消后不应播报');
    } finally {
      harness.dispose();
      plugin.setSpawnForTest(undefined);
    }
  });

  await test('子代理回合、错误回合、非结束事件都不播报', async () => {
    const calls = [];
    plugin.setSpawnForTest(fakeSpawn(calls));
    const harness = fakeContext();
    plugin.apply(harness.ctx, { debounceMs: 0 });
    try {
      const child = fakeSession({ id: 'child', header: { parentSession: 'parent' } });
      harness.emit('session/event', child, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      harness.emit('session/event', fakeSession({ id: 's2' }), { type: 'turn/end', data: { reason: { kind: 'error' } } });
      harness.emit('session/event', fakeSession({ id: 's3' }), { type: 'assistant/message', data: {} });
      await sleep(60);
      assert.equal(calls.length, 0);
    } finally {
      harness.dispose();
      plugin.setSpawnForTest(undefined);
    }
  });

  await test('apply 时不改配置对象、enabled=false 直接不注册', () => {
    const harness = fakeContext();
    plugin.apply(harness.ctx, { enabled: false });
    assert.equal(harness.listenerCount('session/event'), 0);
    harness.dispose();
  });

  await test('卸载时清掉定时器并结束播放器', async () => {
    const calls = [];
    plugin.setSpawnForTest(fakeSpawn(calls));
    const harness = fakeContext();
    plugin.apply(harness.ctx, { debounceMs: 500 });
    harness.emit('session/event', fakeSession(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    harness.dispose();
    await sleep(600);
    assert.equal(calls.length, 0, '卸载后不应再播报');
    plugin.setSpawnForTest(undefined);
  });

  await test('播放器同一时间只跑一条，排队只留最新', async () => {
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    plugin.setSpawnForTest((command, args, options) => {
      calls.push({ command, args, options });
      return {
        once(event, callback) {
          if (event === 'exit') gate.then(() => callback());
        },
        kill() {},
      };
    });
    const config = plugin.normalizeConfig({});
    const speaker = plugin.createSpeaker(config);
    try {
      speaker.say('第一条');
      speaker.say('第二条');
      speaker.say('第三条');
      assert.equal(calls.length, 1, '同一时间只能有一条');
      release();
      await sleep(30);
      await sleep(30);
      assert.equal(calls.length, 2, '第一条跑完后只补最新那条');
    } finally {
      speaker.dispose();
      plugin.setSpawnForTest(undefined);
    }
  });

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(`共 ${results.length} 项，通过 ${passed} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const item of failed) {
      console.log('  FAIL ' + item.name + ': ' + (item.error && item.error.stack ? item.error.stack : item.error));
    }
    process.exitCode = 1;
  }
})();
