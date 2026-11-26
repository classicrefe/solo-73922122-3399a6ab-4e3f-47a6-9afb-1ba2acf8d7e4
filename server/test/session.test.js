'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const SyncSession = require('../../shared/session.js');
const Engine = require('../../shared/engine.js');

// 传输无关的假 WebSocket：只记录发出的报文，不自动应答
class FakeWS {
  constructor() {
    this.sent = [];
    this.readyState = 1; // OPEN
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() { this.readyState = 3; }
  ops() {
    return this.sent.filter((m) => m.type === 'op').map((m) => m.op);
  }
}

function snapshotFor(ops, peerCount) {
  const state = Engine.createInitialState();
  for (const op of ops) {
    if (!state.allOpIds[op.id]) Engine.applyOp(state, op);
  }
  return { type: 'snapshot', snapshot: Engine.toSnapshot(state), peerCount: peerCount || 0 };
}

function paint(id, color, clientSeq) {
  return {
    id, type: 'paint', author: 'A', color,
    cells: [{ row: 1, col: 1 }], clientSeq
  };
}

describe('会话：重连发闸与按序补交', () => {
  test('快照到达前（含重连等快照期）产生的操作只排队不发线，开闸后按本机顺序补交', () => {
    const ws = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws);
    assert.strictEqual(s.gateOpen, false);

    const op1 = s.makePaint('gold', [{ row: 1, col: 1 }]);
    const op2 = s.makePaint('crimson', [{ row: 1, col: 1 }]);
    // 关闸期间一笔都不能发线
    assert.strictEqual(ws.ops().length, 0);
    assert.deepStrictEqual(s.pending.map((o) => o.id), [op1.id, op2.id]);

    s.handleMessage(snapshotFor([])); // 服务端快照里两笔都还没有
    assert.strictEqual(s.gateOpen, true);
    const sent = ws.ops();
    assert.deepStrictEqual(sent.map((o) => o.id), [op1.id, op2.id],
      '开闸后必须严格按本机 clientSeq 顺序补交');
    assert.deepStrictEqual(sent.map((o) => o.clientSeq), [1, 2]);
    // 发线报文中不得夹带本机内部字段
    assert.ok(!('_sent' in sent[0]) && !('_acked' in sent[0]));
  });

  test('快照已含断线期间被受理的操作时，对账出队且不重复补交', () => {
    const ws = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws);
    const op1 = s.makePaint('gold', [{ row: 1, col: 1 }]);
    const op2 = s.makePaint('jade', [{ row: 1, col: 2 }]);
    // op1 已在服务端（例如断线前发出且被受理，只是应答丢了），op2 没有
    s.handleMessage(snapshotFor([op1]));
    const sent = ws.ops();
    assert.deepStrictEqual(sent.map((o) => o.id), [op2.id]);
    assert.deepStrictEqual(s.pending.map((o) => o.id), [op2.id]);
    assert.ok(s.confirmed.allOpIds[op1.id]);
  });

  test('手动重发走同一队列，不能让后产生的操作插队', () => {
    const ws = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws);
    s.handleMessage(snapshotFor([]));
    const op1 = s.makePaint('gold', [{ row: 1, col: 1 }]);
    const op2 = s.makePaint('crimson', [{ row: 1, col: 1 }]);
    assert.deepStrictEqual(ws.ops().map((o) => o.id), [op1.id, op2.id]);

    // 再点一次“重发待确认”：仍是 1 在前 2 在后，顺序不变
    s.resendPending();
    const all = ws.ops().map((o) => o.id);
    assert.deepStrictEqual(all, [op1.id, op2.id, op1.id, op2.id]);
    const first = all.indexOf(op1.id);
    const second = all.indexOf(op2.id);
    assert.ok(first < second);
    // 服务端按此顺序受理时，后产生的绛红必须在上层
    const state = s.viewState();
    assert.strictEqual(Engine.topColor(state, 1, 1), 'crimson');
  });

  test('ack 先于广播 op 到达：本地重绘不回退旧色，广播到达后才出队', () => {
    const ws = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws);
    s.handleMessage(snapshotFor([]));
    const op = s.makePaint('jade', [{ row: 5, col: 5 }]);

    // 回执先到：只标记，不出队
    s.handleMessage({ type: 'ack', opId: op.id, seq: 1 });
    assert.strictEqual(s.pending.length, 1, 'ack 不应让操作出队');
    assert.strictEqual(s.pending[0]._acked, true);
    // 此时任何一帧重绘都必须仍是乐观的新色
    assert.strictEqual(Engine.topColor(s.viewState(), 5, 5), 'jade',
      '回执先到不能让本地视图闪回旧色');

    // 携带完整记录的广播到达：才真正出队，确认态接管
    const record = Object.assign({}, op, { seq: 1, active: true });
    s.handleMessage({ type: 'op', op: record, peerCount: 1 });
    assert.strictEqual(s.pending.length, 0);
    assert.strictEqual(Engine.topColor(s.confirmed, 5, 5), 'jade');
    assert.strictEqual(Engine.topColor(s.viewState(), 5, 5), 'jade');
  });

  test('补交途中再次断线：已收下的操作只生效一次，余下的重连后按序接着补交', () => {
    // 第一轮连接：三笔待交，开闸后只发出前两笔就断线
    const ws1 = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws1);
    s.handleMessage(snapshotFor([]));
    const op1 = s.makePaint('gold', [{ row: 1, col: 1 }]);
    const op2 = s.makePaint('jade', [{ row: 1, col: 2 }]);
    const op3 = s.makePaint('plum', [{ row: 1, col: 3 }]);
    assert.deepStrictEqual(ws1.ops().map((o) => o.id), [op1.id, op2.id, op3.id]);

    // 服务端只受理了 op1（op2/op3 的报文随断连丢失）
    s.markDisconnected();

    // 断线期间还能继续落笔/撤销/恢复
    const op4 = s.makePaint('teal', [{ row: 2, col: 2 }]);
    const undo = s.makeToggle(op4.id, 'undo');
    const redo = s.makeToggle(op4.id, 'redo');
    assert.strictEqual(s.pending.length, 6);
    // 断线乐观视图：undo 后又 redo，teal 仍有效
    assert.strictEqual(Engine.topColor(s.viewState(), 2, 2), 'teal');

    // 重连：新快照里只有 op1；对账后其余 5 笔按原顺序整体补交（op1 不重发）
    const ws2 = new FakeWS();
    s.attach(ws2);
    assert.strictEqual(ws2.ops().length, 0, '新连接开闸前不得发线');
    s.handleMessage(snapshotFor([op1]));
    const resent = ws2.ops().map((o) => o.id);
    assert.deepStrictEqual(resent, [op2.id, op3.id, op4.id, undo.id, redo.id],
      '已收下的 op1 不重发，余下操作按原操作顺序补交');
  });

  test('duplicate 错误：本地补效果不回退，并主动 resync 索账', () => {
    const ws = new FakeWS();
    const s = new SyncSession('A');
    s.attach(ws);
    s.handleMessage(snapshotFor([]));
    const op = s.makePaint('slate', [{ row: 8, col: 8 }]);
    assert.strictEqual(Engine.topColor(s.viewState(), 8, 8), 'slate');

    s.handleMessage({ type: 'error', opId: op.id, duplicate: true, reason: '重复的操作 id' });
    // 出队但确认态已补入同色，显示不回退
    assert.strictEqual(s.pending.length, 0);
    assert.strictEqual(Engine.topColor(s.viewState(), 8, 8), 'slate');
    assert.ok(ws.sent.some((m) => m.type === 'resync'));

    // 服务端快照到达后与确认态一致
    s.handleMessage(snapshotFor([Object.assign({}, op, { seq: 1, active: true })]));
    assert.strictEqual(Engine.topColor(s.confirmed, 8, 8), 'slate');
  });
});
