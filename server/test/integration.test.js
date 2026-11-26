'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const SyncSession = require('../../shared/session.js');
const Engine = require('../../shared/engine.js');
const Pattern = require('../../shared/pattern.js');

process.env.PORT = '0'; // 让内核分配空闲端口
const { server, wss } = require('../server.js');

let baseUrl;

function connect() {
  return new WebSocket(baseUrl + '/ws');
}

// 用浏览器同款会话类驱动一个测试客户端
async function makeClient(station) {
  const ws = connect();
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const session = new SyncSession(station);
  let gotSnapshot = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'snapshot') gotSnapshot = true;
    session.handleMessage(m);
  });
  session.attach(ws);
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (gotSnapshot) { clearInterval(timer); resolve(); }
    }, 5);
  });
  return { ws, session };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function settle(ms) {
  return wait(ms || 120);
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'ws://127.0.0.1:' + server.address().port;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('集成：双工位协同改色', () => {
  test('两笔交叠按服务端接收顺序叠色，撤销露出下层、恢复回原位', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    const opA = a.session.makePaint('gold', [{ row: 3, col: 3 }, { row: 3, col: 4 }]);
    await settle();
    const opB = b.session.makePaint('jade', [{ row: 3, col: 3 }]);
    await settle();

    assert.strictEqual(Engine.topColor(a.session.confirmed, 3, 3), 'jade');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 3, 3), 'jade');
    assert.strictEqual(Engine.topColor(a.session.confirmed, 3, 4), 'gold');
    assert.deepStrictEqual(
      Engine.cellStack(a.session.confirmed, 3, 3).map((p) => p.id),
      [opA.id, opB.id]
    );

    // B 撤销自己的上层笔 → 露出 A 的下层颜色
    b.session.makeToggle(opB.id, 'undo');
    await settle();
    assert.strictEqual(Engine.topColor(a.session.confirmed, 3, 3), 'gold');
    assert.strictEqual(b.session.confirmed.paints[opB.id].active, false);
    // 层序不变，撤销只是翻标志位
    assert.deepStrictEqual(
      b.session.confirmed.cellPaintIds[3][3], [opA.id, opB.id]
    );

    // B 恢复 → 回到原层位（仍在 A 之上）
    b.session.makeToggle(opB.id, 'redo');
    await settle();
    assert.strictEqual(Engine.topColor(a.session.confirmed, 3, 3), 'jade');
    assert.strictEqual(b.session.confirmed.paints[opB.id].active, true);

    a.ws.close();
    b.ws.close();
    await settle();
  });

  test('操作重发只生效一次（幂等）', async () => {
    const a = await makeClient('A');
    const seqBefore = a.session.confirmed.seq;
    const op = a.session.makePaint('plum', [{ row: 6, col: 6 }]);
    await settle();

    // 模拟应答丢失：手动再发一遍同一个 id
    a.ws.send(JSON.stringify({ type: 'op', op }));
    await settle();

    // 只新增一笔，seq 只前进 1；重复 id 被服务端去重
    assert.strictEqual(a.session.confirmed.seq, seqBefore + 1);
    assert.strictEqual(a.session.confirmed.paints[op.id].color, 'plum');
    assert.ok(a.session.confirmed.allOpIds[op.id]);
    assert.strictEqual(a.session.pending.length, 0);

    a.ws.close();
    await settle();
  });

  test('断线期间继续改色/撤销/恢复，重连按本机顺序补交，最终两边一致', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    // 先有一笔 A 的底层笔，双方确认
    const basePaint = a.session.makePaint('gold', [{ row: 9, col: 9 }]);
    await settle();
    assert.strictEqual(a.session.pending.length, 0);

    // B 断线
    b.ws.close();
    b.session.markDisconnected();
    await settle(300);

    // B 断线期间：改色一笔、再撤销自己更早的一笔（此前 B 无笔迹，改为对断线后新笔做撤销）
    const offlinePaint = b.session.makePaint('jade', [{ row: 9, col: 9 }, { row: 9, col: 10 }]);
    const offlineUndo = b.session.makeToggle(offlinePaint.id, 'undo');
    const offlineRedo = b.session.makeToggle(offlinePaint.id, 'redo');
    assert.strictEqual(b.session.pending.length, 3);

    // 乐观视图：redo 后该笔重新有效
    assert.strictEqual(Engine.topColor(b.session.viewState(), 9, 9), 'jade');

    // 重连：attach 收快照 → 对账 → 按 clientSeq 顺序补交三笔
    const ws2 = connect();
    await new Promise((resolve, reject) => {
      ws2.once('open', resolve);
      ws2.once('error', reject);
    });
    b.ws = ws2;
    ws2.on('message', (raw) => b.session.handleMessage(JSON.parse(raw.toString())));
    b.session.attach(ws2);
    await settle(300);

    assert.strictEqual(b.session.connected, true);
    assert.strictEqual(b.session.pending.length, 0, '补交后不应有待确认操作');
    assert.ok(b.session.confirmed.allOpIds[offlinePaint.id]);
    assert.ok(b.session.confirmed.allOpIds[offlineUndo.id]);
    assert.ok(b.session.confirmed.allOpIds[offlineRedo.id]);

    // 补交顺序必须是 paint → undo → redo（本机 clientSeq 顺序）
    const seqs = [
      b.session.confirmed.paints[offlinePaint.id].seq,
      b.session.confirmed.undoOps[offlineUndo.id].seq,
      b.session.confirmed.undoOps[offlineRedo.id].seq
    ];
    assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], '补交顺序应为 paint→undo→redo');

    // 最终两边看到同一张色格图
    assert.strictEqual(Engine.topColor(a.session.confirmed, 9, 9), 'jade');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 9, 9), 'jade');
    assert.strictEqual(Engine.topColor(a.session.confirmed, 9, 10), 'jade');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 9, 10), 'jade');
    assert.deepStrictEqual(
      Engine.toSnapshot(a.session.confirmed).paints.map((p) => p.id).sort(),
      Engine.toSnapshot(b.session.confirmed).paints.map((p) => p.id).sort()
    );
    assert.strictEqual(a.session.confirmed.seq, b.session.confirmed.seq);

    // A 的底层笔仍在 B 的笔之下，层位未被重连打乱
    const stack = Engine.cellStack(b.session.confirmed, 9, 9);
    assert.deepStrictEqual(stack.map((p) => p.id), [basePaint.id, offlinePaint.id]);

    a.ws.close();
    ws2.close();
    await settle();
  });

  test('断线期间两端同时改同一格，重连补交后按服务端受理顺序收敛', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    b.ws.close();
    b.session.markDisconnected();
    await settle(200);

    // A 在线画 indigo；B 断线本地画 crimson（乐观显示自己在上）
    a.session.makePaint('indigo', [{ row: 12, col: 12 }]);
    await settle();
    const bOp = b.session.makePaint('crimson', [{ row: 12, col: 12 }]);
    assert.strictEqual(Engine.topColor(b.session.viewState(), 12, 12), 'crimson');

    const ws2 = connect();
    await new Promise((r, rej) => { ws2.once('open', r); ws2.once('error', rej); });
    ws2.on('message', (raw) => b.session.handleMessage(JSON.parse(raw.toString())));
    b.ws = ws2;
    b.session.attach(ws2);
    await settle(300);

    // B 后受理，故 B 在上；两端收敛到同一结果
    assert.strictEqual(b.session.pending.length, 0);
    assert.strictEqual(Engine.topColor(a.session.confirmed, 12, 12), 'crimson');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 12, 12), 'crimson');
    assert.deepStrictEqual(
      Engine.cellStack(b.session.confirmed, 12, 12).map((p) => p.author),
      ['A', 'B']
    );

    // 撤销 B 的笔，露出 A 的下层
    b.session.makeToggle(bOp.id, 'undo');
    await settle();
    assert.strictEqual(Engine.topColor(a.session.confirmed, 12, 12), 'indigo');

    a.ws.close();
    ws2.close();
    await settle();
  });

  test('服务端以连接身份覆盖 author，拒绝越权撤销', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    const op = a.session.makePaint('gold', [{ row: 15, col: 15 }]);
    await settle();

    // B 伪造 author=A 去撤销 A 的笔
    const fake = {
      id: 'evil-1', type: 'undo', author: 'A', paintId: op.id, clientSeq: 99
    };
    let errorMsg = null;
    const onErr = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'error') errorMsg = m;
    };
    b.ws.on('message', onErr);
    b.ws.send(JSON.stringify({ type: 'op', op: fake }));
    await settle();

    assert.ok(errorMsg, '应返回 error');
    assert.match(errorMsg.reason, /自己的笔/);
    assert.strictEqual(a.session.confirmed.paints[op.id].active, true);

    a.ws.close();
    b.ws.close();
    await settle();
  });
});
