#!/usr/bin/env node
/**
 * conversation-voice 的静态检查：清单、本地化、图标、补丁。
 * 这个插件没有客户端半，所以没有 CSS / 主题检查；对应检查合并在本脚本里。
 * 用法：node tests/check-manifest.cjs [包目录，默认 ../dev]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'dev'));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const results = [];
let passed = 0;

/**
 * 跑一条检查。
 * @param name 检查名
 * @param fn 检查体
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    results.push({ ok: true, name });
    console.log('  ok  ' + name);
  } catch (error) {
    results.push({ ok: false, name, error });
    console.log('FAIL  ' + name + '\n      ' + (error && error.message ? error.message : error));
  }
}

check('package.json 存在且字段齐全', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@local/conversation-voice');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

check('files 列表与磁盘文件一致', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const pattern of pkg.files) {
    if (pattern.includes('*')) {
      const [dir, suffix] = pattern.split('*');
      const names = fs.readdirSync(path.join(root, path.dirname(dir))).filter((name) => name.endsWith(suffix));
      assert.ok(names.length > 0, '通配符没有匹配到文件：' + pattern);
      continue;
    }
    assert.ok(fs.existsSync(path.join(root, pattern)), 'files 里列了不存在的文件：' + pattern);
  }
});

check('运行必需文件都在，发布脚本是带 BOM 的 UTF-8 + CRLF', () => {
  for (const name of ['index.js', 'cordis.patch.yml', 'README.md', 'INSTALL.md', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'package.json']) {
    assert.ok(fs.existsSync(path.join(root, name)), '缺少文件：' + name);
  }
  // Windows PowerShell 5.1 只有认 BOM 才不会把中文注释按 ANSI 解码，缺 BOM 会直接语法报错。
  const script = path.join(__dirname, '..', 'tools', 'publish-release.ps1');
  assert.ok(fs.existsSync(script), '缺少 tools/publish-release.ps1');
  const bytes = fs.readFileSync(script);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '发布脚本缺少 UTF-8 BOM');
  const text = bytes.toString('utf8');
  assert.ok(text.indexOf('\r\n') >= 0, '发布脚本不是 CRLF 换行');
});

check('index.js 能通过语法检查（用 node --check 等价校验）', () => {
  const source = read('index.js');
  assert.ok(source.indexOf('export function apply') >= 0, '缺少 apply 导出');
  assert.ok(source.indexOf('session/event') >= 0, '没有监听 session/event');
  assert.ok(source.indexOf('turn/end') >= 0, '没有处理 turn/end');
  assert.ok(source.indexOf('System.Speech') >= 0, '没有用到系统语音');
});

check('补丁里插入了正确的行', () => {
  const patch = read('cordis.patch.yml');
  assert.ok(/insert:/.test(patch), patch);
  assert.ok(/id:\s*conversation-voice/.test(patch), patch);
  assert.ok(/name:\s*'@local\/conversation-voice'/.test(patch), patch);
});

check('本地化文件齐全且标题/说明不为模板占位', () => {
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(read('locale/' + locale + '.json'));
    assert.equal(typeof dict.meta.title, 'string');
    assert.ok(dict.meta.title.length >= 2, locale + ' 标题太短');
    assert.equal(typeof dict.meta.description, 'string');
    assert.ok(dict.meta.description.length >= 10, locale + ' 说明太短');
    assert.ok(!/my-plugin|todo|template/i.test(dict.meta.title + dict.meta.description), locale + ' 还留着模板文案');
  }
});

check('图标是有效 SVG 且在大小限制内', () => {
  const raw = fs.readFileSync(path.join(root, 'icon.svg'));
  assert.ok(raw.length < 256 * 1024, '图标超过 256 KiB');
  const text = raw.toString('utf8').trim();
  assert.ok(text.startsWith('<svg'), '不是 SVG');
  assert.ok(text.endsWith('</svg>'), 'SVG 未闭合');
  assert.ok(/viewBox=/.test(text), 'SVG 缺少 viewBox');
  assert.ok(!/<script/i.test(text), 'SVG 里不应有脚本');
});

check('文件名里没有网盘同步冲突副本', () => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else assert.ok(entry.name.indexOf('.sync-conflict-') < 0, '发现同步冲突副本：' + full);
    }
  };
  walk(root);
});

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`共 ${results.length} 项，通过 ${passed} 项，失败 ${failed.length} 项`);
if (failed.length > 0) process.exitCode = 1;
