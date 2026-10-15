import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUrls, isAt, segmentsToText, splitReply, stripAt, textSeg } from '../src/segments.js';
import { cleanReply } from '../src/bot.js';

test('segmentsToText：拼接文本、@、图片占位', () => {
  const msg = [
    textSeg('你好'),
    { type: 'at', data: { qq: '10001', name: '小明' } },
    { type: 'image', data: { file: 'x.jpg' } },
    textSeg('看这个'),
  ];
  assert.equal(segmentsToText(msg), '你好@小明[图片]看这个');
});

test('segmentsToText：@全体成员', () => {
  assert.equal(segmentsToText([{ type: 'at', data: { qq: 'all' } }]), '@全体成员');
});

test('segmentsToText：纯 CQ 字符串直接返回', () => {
  assert.equal(segmentsToText('  hello  '), 'hello');
});

test('isAt：识别 @自己 与 @全体成员', () => {
  assert.equal(isAt([{ type: 'at', data: { qq: '123' } }], '123'), true);
  assert.equal(isAt([{ type: 'at', data: { qq: 'all' } }], '123'), true);
  assert.equal(isAt([{ type: 'at', data: { qq: '999' } }], '123'), false);
  assert.equal(isAt([textSeg('hi')], '123'), false);
});

test('stripAt：去掉对自己的 @，保留其他人的 @', () => {
  const msg = [
    { type: 'at', data: { qq: '123', name: '我' } },
    textSeg(' 在吗 '),
    { type: 'at', data: { qq: '999', name: '别人' } },
  ];
  // 段内原有的前后空格会被保留（忠实还原原话），只断言 @自己 被摘除
  assert.equal(stripAt(msg, '123').replace(/\s+/g, ''), '在吗@别人');
});

test('splitReply：短文本不切分', () => {
  assert.deepEqual(splitReply('好的', { maxLength: 90 }), ['好的']);
});

test('splitReply：长文本在句末标点处切分', () => {
  const text = '今天下午我有事情要忙。晚上的话应该就有空了。到时候再说吧。';
  const chunks = splitReply(text, { maxLength: 12, maxSegments: 3 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  for (const c of chunks.slice(0, -1)) assert.ok(c.length <= 12, `分段过长：${c}`);
});

test('splitReply：不丢内容且不超过 maxSegments', () => {
  const text = '一二三四五六七八九十'.repeat(10);
  const chunks = splitReply(text, { maxLength: 10, maxSegments: 3 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(''), text);
});

test('splitReply：空输入返回空数组', () => {
  assert.deepEqual(splitReply('   '), []);
});

// 换行优先：模型用换行表示"这是下一条消息"，这正是我们想要的分段方式。
test('splitReply：优先按换行切气泡（换行 = 一条消息）', () => {
  assert.deepEqual(splitReply('我也想你\n刚才还在想，你今晚会不会来'), [
    '我也想你',
    '刚才还在想，你今晚会不会来',
  ]);
  // 空行、行首行尾空白、连续换行都不该产生空气泡
  assert.deepEqual(splitReply('甲\n\n\n乙\n  \n丙'), ['甲', '乙', '丙']);
  // 关掉换行切分时退回旧行为：压成一行再按标点切
  assert.deepEqual(splitReply('甲\n乙', { bubbleOnNewline: false }), ['甲 乙']);
});

test('splitReply：换行多于 maxSegments 时合并进最后一条，不丢内容', () => {
  const chunks = splitReply('一\n二\n三\n四', { maxSegments: 2 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(' ').replace(/\s+/g, ''), '一二三四');
});

test('splitReply：单行太长时退回按标点切分', () => {
  const text = '今天下午我有事情要忙。晚上的话应该就有空了。到时候再说吧。除了这些还有别的安排要处理一下。';
  const chunks = splitReply(text, { maxLength: 12, maxSegments: 5 });
  assert.ok(chunks.length > 1);
  for (const c of chunks.slice(0, -1)) assert.ok(c.length <= 12, `分段过长：${c}`);
  assert.equal(chunks.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('cleanReply：去掉包裹引号、AI 前缀', () => {
  assert.equal(cleanReply('"你好啊"'), '你好啊');
  assert.equal(cleanReply('AI: 我在的'), '我在的');
  assert.equal(cleanReply('```\n你好\n```'), '你好');
  assert.equal(cleanReply('  '), '');
});

// 换行以前被抹成空格，逼着模型改用句号分段，越积越多（实测：给她看带句号的历史，
// 新回复的句号从 2 个涨到 3 个；把历史的句号清掉，新回复 0 个句号）。
// 现在换行 = 气泡边界，必须保留。
test('cleanReply：保留换行（换行是气泡边界），并折叠空行、逐行剥引号', () => {
  assert.equal(cleanReply('第一行\n第二行'), '第一行\n第二行');
  assert.equal(cleanReply('我也想你\n\n刚才还在想，你今晚会不会来'), '我也想你\n刚才还在想，你今晚会不会来');
  assert.equal(cleanReply('  \n 你好  \n\n  '), '你好');
  assert.equal(cleanReply('"你好"\n"在吗"'), '你好\n在吗');
});

// 回归测试：人设文件第四节用「」举例台词，模型会学着一起打出来。
// QQ 里书名号很出戏，必须在发送前剥掉。
test('cleanReply：剥掉人设范例带来的书名号与星号动作', () => {
  assert.equal(cleanReply('「开拓者，今天想去哪儿？」'), '开拓者，今天想去哪儿？');
  assert.equal(cleanReply('『萨姆』是我生命的摇篮'), '萨姆是我生命的摇篮');
  assert.equal(cleanReply('「嗯……让我想想。」'), '嗯……让我想想。');
  assert.equal(cleanReply('*歪头* 你说什么'), '歪头 你说什么');
  // 只脱壳，不该误伤正常的书名号内容以外的文字
  assert.equal(cleanReply('火萤这种生物很神奇吧？'), '火萤这种生物很神奇吧？');
});

// 回归测试：图片的 url 一直躺在 OneBot 消息段里，但 segmentsToText 只把它换成
// 「[图片]」三个字，地址被整个丢掉 —— 模型于是永远看不到图。imageUrls 负责把地址捡回来。
test('imageUrls：把图片地址捡出来（优先 url，退回 file）', () => {
  const msg = [
    textSeg('看这个'),
    { type: 'image', data: { url: 'https://x/a.jpg', file: 'a.jpg' } },
    { type: 'image', data: { file: 'https://x/b.png' } },
    { type: 'at', data: { qq: '123' } },
  ];
  assert.deepEqual(imageUrls(msg), ['https://x/a.jpg', 'https://x/b.png']);
});

test('imageUrls：同一个地址只取一次，非数组与无图消息返回空数组', () => {
  const dup = [
    { type: 'image', data: { url: 'https://x/a.jpg' } },
    { type: 'image', data: { url: 'https://x/a.jpg' } },
  ];
  assert.deepEqual(imageUrls(dup), ['https://x/a.jpg']);
  assert.deepEqual(imageUrls([textSeg('没有图')]), []);
  assert.deepEqual(imageUrls('hello'), []);
  assert.deepEqual(imageUrls(null), []);
  // 只有空白的地址当作没有
  assert.deepEqual(imageUrls([{ type: 'image', data: { url: '   ' } }]), []);
});
