'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const SyncSession = require('../../shared/session.js');
const Engine = require('../../shared/engine.js');

process.env.PORT = '0'; // 让内核分配空闲端口
const { server, wss } = require('../server.js');

let baseUrl;

function connect() {
  return new WebSocket(baseUrl + '/ws');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (ms) => wait(ms || 120);

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
  while (!gotSnapshot) await wait(5);
  return { ws, session };
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'ws://127.0.0.1:' + server.address().port;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('集成：重连过程的顺序与不回退', () => {
  test('等快照期间接着落笔：断线旧笔先受理、同格新笔后受理，双方收敛同一张图', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    b.ws.close();
    b.session.markDisconnected();
    await settle(200);

    // 断线后先刷一笔赭金
    const gold = b.session.makePaint('gold', [{ row: 20, col: 20 }]);

    // 重连：hello 已发、快照未到的窗口里，同一格再刷绛红
    const ws2 = connect();
    await new Promise((r, j) => { ws2.once('open', r); ws2.once('error', j); });
    const beforeSnapshot = [];
    let snapshotArrived = false;
    const rawSend = ws2.send.bind(ws2);
    ws2.send = function (data, cb) {
      const m = JSON.parse(data.toString());
      if (m.type === 'op' && !snapshotArrived) beforeSnapshot.push(m.op.id);
      return rawSend(data, cb);
    };
    ws2.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'snapshot') snapshotArrived = true;
      b.session.handleMessage(m);
    });
    b.session.attach(ws2); // 发 hello，闸门关闭
    const crimson = b.session.makePaint('crimson', [{ row: 20, col: 20 }]);
    assert.strictEqual(b.session.pending.length, 2);

    await settle(300);

    // 关闸期间不得有任何 op 发线
    assert.deepStrictEqual(beforeSnapshot, [], '快照对账前不允许业务操作发线');
    assert.strictEqual(b.session.pending.length, 0);
    // 服务端受理顺序必须与本机操作顺序一致：gold 先、crimson 后
    assert.ok(
      b.session.confirmed.paints[gold.id].seq <
      b.session.confirmed.paints[crimson.id].seq,
      '赭金（断线旧笔）必须先于绛红（等快照新笔）受理'
    );
    // 交叠格最终是后受理的绛红，而不是赭金
    assert.strictEqual(Engine.topColor(b.session.confirmed, 20, 20), 'crimson');
    assert.strictEqual(Engine.topColor(a.session.confirmed, 20, 20), 'crimson');
    assert.deepStrictEqual(
      Engine.cellStack(b.session.confirmed, 20, 20).map((p) => p.id),
      [gold.id, crimson.id]
    );

    a.ws.close();
    ws2.close();
    await settle();
  });

  test('另一工位同期改图：双方交叠笔按服务端受理顺序叠色，撤销露下层', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    b.ws.close();
    b.session.markDisconnected();
    await settle(200);

    const bGold = b.session.makePaint('gold', [{ row: 21, col: 21 }]);

    // B 断线期间，A 在线照常改同一格（先被服务端受理）
    a.session.makePaint('jade', [{ row: 21, col: 21 }]);
    await settle();

    const ws2 = connect();
    await new Promise((r, j) => { ws2.once('open', r); ws2.once('error', j); });
    ws2.on('message', (raw) => b.session.handleMessage(JSON.parse(raw.toString())));
    b.session.attach(ws2);
    // 等快照窗口内 B 又在同格补一笔
    const bCrimson = b.session.makePaint('crimson', [{ row: 21, col: 21 }]);
    await settle(300);

    // 受理顺序：A 的 jade → B 补交的 gold → B 的 crimson
    const seqA = a.session.confirmed.cellPaintIds[21][21]
      .map((id) => a.session.confirmed.paints[id].seq);
    assert.deepStrictEqual(
      Engine.cellStack(a.session.confirmed, 21, 21).map((p) => p.color),
      ['jade', 'gold', 'crimson']
    );
    assert.strictEqual(Engine.topColor(a.session.confirmed, 21, 21), 'crimson');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 21, 21), 'crimson');
    assert.ok(a.session.confirmed.paints[
      a.session.confirmed.cellPaintIds[21][21][0]].seq <
      b.session.confirmed.paints[bGold.id].seq);
    assert.ok(b.session.confirmed.paints[bGold.id].seq <
      b.session.confirmed.paints[bCrimson.id].seq);
    assert.ok(seqA.length === 3);

    // B 撤销最上层 crimson，露出 A 受理在中间层之前的顺序不变，露下层 gold
    b.session.makeToggle(bCrimson.id, 'undo');
    await settle();
    assert.strictEqual(Engine.topColor(a.session.confirmed, 21, 21), 'gold');
    b.session.makeToggle(bCrimson.id, 'redo');
    await settle();
    assert.strictEqual(Engine.topColor(a.session.confirmed, 21, 21), 'crimson');

    a.ws.close();
    ws2.close();
    await settle();
  });

  test('回执先于笔迹更新到达：全程无旧色回退，广播后由确认态接管', async () => {
    const a = await makeClient('A');
    a.ws.close();
    a.session.markDisconnected();
    await settle(150);

    const op = a.session.makePaint('ivory', [{ row: 22, col: 22 }]);

    const ws2 = connect();
    await new Promise((r, j) => { ws2.once('open', r); ws2.once('error', j); });
    let ackFrameColor = '未触发';
    ws2.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      a.session.handleMessage(m);
      if (m.type === 'ack') {
        // 模拟浏览器在 ack 后立刻重绘一帧（此时广播 op 尚未到达）
        ackFrameColor = Engine.topColor(a.session.viewState(), 22, 22);
      }
    });
    a.session.attach(ws2);
    await settle(300);

    assert.strictEqual(ackFrameColor, 'ivory', 'ack 后广播前的重绘不能回退');
    assert.strictEqual(a.session.pending.length, 0);
    assert.strictEqual(Engine.topColor(a.session.confirmed, 22, 22), 'ivory');
    assert.strictEqual(Engine.topColor(a.session.viewState(), 22, 22), 'ivory');
    assert.ok(a.session.confirmed.allOpIds[op.id]);

    ws2.close();
    await settle();
  });

  test('补交途中再次断线：已受理操作不重复生效，余下按序补交，最终一致', async () => {
    const a = await makeClient('A');
    const b = await makeClient('B');

    b.ws.close();
    b.session.markDisconnected();
    await settle(150);

    // 断线期攒四笔，落在不同格，便于逐笔核对
    const ops = [
      b.session.makePaint('gold', [{ row: 23, col: 20 }]),
      b.session.makePaint('jade', [{ row: 23, col: 21 }]),
      b.session.makePaint('plum', [{ row: 23, col: 22 }]),
      b.session.makePaint('teal', [{ row: 23, col: 23 }])
    ];

    // 第一次重连：用一次性代理只放行前两笔的 op，随后立刻断开
    const seqBefore = a.session.confirmed.seq;
    const wsMid = connect();
    await new Promise((r, j) => { wsMid.once('open', r); wsMid.once('error', j); });
    let passed = 0;
    const midSend = wsMid.send.bind(wsMid);
    wsMid.send = function (data, cb) {
      const m = JSON.parse(data.toString());
      if (m.type === 'op') {
        passed += 1;
        if (passed > 2) return; // 后两笔卡住不发
      }
      return midSend(data, cb);
    };
    wsMid.on('message', (raw) => b.session.handleMessage(JSON.parse(raw.toString())));
    b.session.attach(wsMid);
    await settle(250);
    wsMid.close();
    b.session.markDisconnected();
    await settle(200);

    // 前两笔应已被服务端受理（广播到达后即出队），后两笔仍在待交队列
    assert.ok(a.session.confirmed.allOpIds[ops[0].id]);
    assert.ok(a.session.confirmed.allOpIds[ops[1].id]);
    assert.ok(!a.session.confirmed.allOpIds[ops[2].id]);
    assert.ok(!a.session.confirmed.allOpIds[ops[3].id]);
    assert.deepStrictEqual(b.session.pending.map((o) => o.id),
      [ops[2].id, ops[3].id]);

    // 第二次重连：快照里已有前两笔，只补交剩余两笔，且顺序不变
    const ws3 = connect();
    await new Promise((r, j) => { ws3.once('open', r); ws3.once('error', j); });
    const observed = [];
    const raw3 = ws3.send.bind(ws3);
    ws3.send = function (data, cb) {
      const m = JSON.parse(data.toString());
      if (m.type === 'op') observed.push(m.op.id);
      return raw3(data, cb);
    };
    ws3.on('message', (raw) => b.session.handleMessage(JSON.parse(raw.toString())));
    b.session.attach(ws3);
    await settle(300);

    assert.deepStrictEqual(observed, [ops[2].id, ops[3].id],
      '已收下的两笔不得重发，余下按原顺序补交');
    assert.strictEqual(b.session.pending.length, 0);

    // 全部四笔各只生效一次：服务端总 seq 增量恰为 4
    assert.strictEqual(a.session.confirmed.seq, seqBefore + 4);
    for (const op of ops) {
      assert.ok(a.session.confirmed.allOpIds[op.id]);
      assert.ok(b.session.confirmed.allOpIds[op.id]);
    }
    assert.strictEqual(a.session.confirmed.seq, b.session.confirmed.seq);
    assert.strictEqual(Engine.topColor(a.session.confirmed, 23, 20), 'gold');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 23, 20), 'gold');
    assert.strictEqual(Engine.topColor(a.session.confirmed, 23, 23), 'teal');
    assert.strictEqual(Engine.topColor(b.session.confirmed, 23, 23), 'teal');
    assert.deepStrictEqual(
      Engine.toSnapshot(a.session.confirmed).allOpIds.slice().sort(),
      Engine.toSnapshot(b.session.confirmed).allOpIds.slice().sort()
    );

    a.ws.close();
    ws3.close();
    await settle();
  });
});
