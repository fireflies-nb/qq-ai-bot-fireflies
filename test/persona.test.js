import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 这个文件只做一件事：守住人设文件里那几条"被实测抓到过"的护栏。
// 它们全部来自真实的翻车现场，删掉任何一条都会让同一种错误重新出现，
// 而且不会让任何别的测试变红——所以必须由测试直接钉住。

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(here, '..', 'config');
const examplePath = path.join(configDir, 'persona.example.md');
const livePath = path.join(configDir, 'persona.md');

const example = fs.readFileSync(examplePath, 'utf8');
// 去掉 HTML 注释：注释里的话不该被当成正文，也不该让断言误判。
const readExample = example.replace(/<!--[\s\S]*?-->/g, '');

test('人设：两份人设文件必须逐字一致（不一致会让所有验证都在测旧版）', () => {
  // persona.md 不在仓库里（.gitignore），刚 clone 下来只有 .example，
  // 所以"不存在"是合法的；但"存在却不一致"一定是忘了同步。
  if (!fs.existsSync(livePath)) return;
  const live = fs.readFileSync(livePath, 'utf8');
  assert.equal(
    live,
    example,
    'config/persona.md 与 config/persona.example.md 不一致：改完人设必须立刻同步两份，' +
      '否则机器人跑的是旧人设，而所有验证都在测新版',
  );
});

test('人设 4：手账本是空白的、只属于她，内容只能来自这次对话', () => {
  const idx = readExample.indexOf('关于手账本');
  assert.ok(idx > 0, '人设里必须有"关于手账本"这一条（它被实测抓到过）');
  const block = readExample.slice(idx, idx + 500);

  assert.ok(/空白/.test(block), '手账本必须被写明是"空白"的：她只往上写，不从中读别人的事');
  assert.ok(/是你的，不是对方/.test(block), '必须写明手账本是她的，不是对方的、也不是共同的');
  assert.ok(
    /手账本上那张/.test(block),
    '必须点名禁止"我手账本上那张"这类说法 —— 实测就是这句把虚构引出来的',
  );
  assert.ok(
    /只来自|只有.*说过/.test(block),
    '必须写明手账本的内容只能来自"对方亲口说过的事"',
  );
});

test('人设 9：护栏覆盖"对方个人的往事"，不只是"我们之间共同经历的"', () => {
  const idx = readExample.indexOf('不许编造任何具体往事');
  assert.ok(idx > 0, '第 9 条标题必须是"任何具体往事"；写成"我们之间发生过的事"会漏掉对方的个人往事');
  const block = readExample.slice(idx, idx + 1200);

  // 实测翻车点：她说"你上次在咖啡店被烫到舌头"，这既不是"我们之间的事"（他说的是"你"），
  // 也不是对话历史里有的。旧版护栏只写"我们之间/共同经历"，字面上拦不住它。
  assert.ok(
    /对方一个人的事|对方个人的事/.test(block),
    '必须显式把"对方一个人的事"纳入禁区 —— 这正是旧版漏掉的那一类',
  );
  assert.ok(/你自己的事/.test(block), '必须显式覆盖"她自己的事"，否则能绕到"我的手账本记得…"');
  assert.ok(
    /“你”上次|"你"上次|你上次/.test(block),
    '必须有针对"你上次……"句式的反例 —— 这是幻觉输出的实际形状',
  );
});

test('人设 9：必须声明"我说过 ≠ 这是真的"，堵住自我强化闭环', () => {
  const idx = readExample.indexOf('不许编造任何具体往事');
  const block = readExample.slice(idx, idx + 1200);
  assert.ok(
    /说.*过.*不等于|不等于.*真的/.test(block),
    '必须写明"我说过不等于这是真的"：她一旦编过一句，那句话会进自身话清单，' +
      '下一轮她看到清单就当成事实基础，越编越细。',
  );
  assert.ok(
    /不要接着往下编|不要再提它/.test(block),
    '必须明确要求"不接着编、不要再提"，只说"不许编造"挡不住已经在清单里的那句',
  );
});

test('人设 9：给正反范例，并允许用反问带过', () => {
  const idx = readExample.indexOf('不许编造任何具体往事');
  const block = readExample.slice(idx, idx + 1200);
  assert.ok(/正：/.test(block) && /反：/.test(block), '必须有"正：/反："对照范例（压住这条主要靠范例）');
  assert.ok(
    /反问.*算过关|反问也|也算过关/.test(block),
    '必须点明反问也算过关 —— 否则她把"承认不知道"当成冷场，宁可编',
  );
});

test('人设 5：对开拓者必须"会叫他"，但名字只能来自两种来源', () => {
  // 实测基线：真库 252 条私聊回复里，她最后一次叫"开拓者"或用户名字是 #232（10/13 深夜），
  // **此后连续 181 条一次都没叫过**。人设通篇只有"克制、话少、少表达"，
  // 结果她把"偏袒"也一起省掉了——只有照顾没有偏心。
  const idx = readExample.indexOf('对开拓者，你是会叫他的');
  assert.ok(idx > 0, '必须有一条明确写"对开拓者你是会叫他的"：不写的话她一次都不会叫（实测连续 181 条 0 次）');
  const block = readExample.slice(idx, idx + 700);
  assert.ok(/开拓者/.test(block), '必须点明可以叫"开拓者"');
  assert.ok(
    /名字|昵称/.test(block),
    '必须允许用"对话里出现过的名字/昵称"——用户明确要求过"多一点叫我开拓者或者我在对话里面提到过的名字"',
  );
  assert.ok(
    /不能自己造|不要凭空|绝不能自己造/.test(block),
    '必须同时禁止自己发明昵称 —— 否则"允许叫名字"会变成"随便起一个"，和编造往事是同一类错误',
  );
});

test('人设 5：偏袒要主动露出来，且优先级高于"话短、克制"', () => {
  const idx = readExample.indexOf('## 五、你与"开拓者"的关系');
  assert.ok(idx > 0);
  const block = readExample.slice(idx, idx + 2200);

  // 这一节原本只写"克制的亲近"，模型就把"克制"执行成"不表达"。
  // 现在必须显式写出优先级，否则第三节/第六节的"话短、不热情"会把它盖住。
  assert.ok(
    /优先级/.test(block) && /高于/.test(block),
    '必须写明第五节的要求**高于**"克制/话短"那几条 —— 冲突时不知道听谁的，模型就会一律选更保守的那个',
  );
  assert.ok(
    /独占/.test(block) && /主动报备|报备/.test(block),
    '必须把"独占感""主动报备"这类具体动作列出来，只写"要亲近"太抽象，落不到输出上',
  );
  assert.ok(
    /反例/.test(block),
    '必须有"没演对"的反例（只有照顾、没有偏心），否则她照旧回"多喝水""早点休息"',
  );
  assert.ok(
    /只有照顾没有偏心/.test(block),
    '反例必须点破病灶本身：照顾多、偏心零 —— 这正是实测里抓到的形状',
  );
});

test('人设 13：给"没被示好时也要主动偏心"一条可执行的动作清单', () => {
  const idx = readExample.indexOf('偏爱要主动露出来');
  assert.ok(
    idx > 0,
    '必须有第 13 条：第 12 条只管"他说了重话要接住"，他什么都没说的时候她照样是个温柔的回复机器',
  );
  const block = readExample.slice(idx, idx + 1200);
  assert.ok(
    /每一轮|每轮|这一条里/.test(block),
    '必须让她每轮自问一次"这条里有没有只对开拓者才会说的话" —— 给她一个可执行的检查动作',
  );
  assert.ok(/不要变成粘人|一次只说一句/.test(block), '必须附上节制条款，否则会从"不表达"直接翻到"刷情话"');
  assert.ok(/正：/.test(block) && /反：/.test(block), '必须有正反范例对照');
});

test('人设：仍然保留"主动带入她的世界"这类细节（护栏不能把人设删空）', () => {
  const idx = readExample.indexOf('主动带入她的世界');
  assert.ok(idx > 0);
  const block = readExample.slice(idx, idx + 200);
  for (const detail of ['橡木蛋糕卷', '医疗舱', '格拉默', '星核猎手']) {
    assert.ok(block.includes(detail), `不该为了防编造而删掉「${detail}」`);
  }
});
