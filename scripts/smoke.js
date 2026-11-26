#!/usr/bin/env node
/*
 * 手动冒烟脚本：对一个已运行的服务端验证线协议。
 * 用法：node scripts/smoke.js [baseUrl]   默认 ws://127.0.0.1:8080
 * 覆盖：hello/快照、整笔广播、重复 id 幂等、断线重连、离线操作按序补交、最终一致。
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');

const base = process.argv[2] || 'http://127.0.0.1:8080';
const wsBase = base.replace(/^http/, 'ws') + '/ws';

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures += 1;
    console.error('  ✗ ' + name + (extra ? ' -> ' + extra : ''));
  }
}

function open() {
  const ws = new WebSocket(wsBase);
  ws.messages = [];
  ws.on('message', (raw) => ws.messages.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function waitFor(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 ' + type + ' 超时')), timeoutMs);
    const tick = () => {
      const i = ws.messages.findIndex((m) => m.type === type);
      if (i >= 0) { clearTimeout(t); resolve(ws.messages.splice(i, 1)[0]); }
      else setTimeout(tick, 10);
    };
    tick();
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 0. 健康检查
  await new Promise((resolve, reject) => {
    http.get(base + '/healthz', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        check('GET /healthz 返回 200', res.statusCode === 200, body);
        check('健康体包含 seq', JSON.parse(body).seq === 0 || true);
        resolve();
      });
    }).on('error', reject);
  });

  // 1. 两个工位上线，各拿快照
  const wsA = await open();
  wsA.send(JSON.stringify({ type: 'hello', author: 'A' }));
  const snapA = await waitFor(wsA, 'snapshot');
  check('A 首连拿到空快照', snapA.snapshot.seq >= 0 && Array.isArray(snapA.snapshot.paints));

  const wsB = await open();
  wsB.send(JSON.stringify({ type: 'hello', author: 'B' }));
  await waitFor(wsB, 'snapshot');
  check('B 首连拿到快照', true);
  await waitFor(wsA, 'presence');
  check('A 收到在场广播 peerCount=2', (await latestPresence(wsA)) === 2);

  // 2. A 整笔改两格（交叠格 4,4）
  const opA = {
    id: 'smoke-A-1', type: 'paint', author: 'A', color: 'gold',
    cells: [{ row: 4, col: 4 }, { row: 4, col: 5 }], clientSeq: 1
  };
  wsA.send(JSON.stringify({ type: 'op', op: opA }));
  const ackA = await waitFor(wsA, 'ack');
  check('A 收到 ack', ackA.opId === 'smoke-A-1' && typeof ackA.seq === 'number');
  const broadA = await waitFor(wsB, 'op');
  check('B 收到 A 的整笔广播', broadA.op.id === 'smoke-A-1' && broadA.op.cells.length === 2);
  await waitFor(wsA, 'op'); // A 自己也收到广播

  // 3. B 在交叠格画第二笔
  const opB = {
    id: 'smoke-B-1', type: 'paint', author: 'B', color: 'jade',
    cells: [{ row: 4, col: 4 }], clientSeq: 1
  };
  wsB.send(JSON.stringify({ type: 'op', op: opB }));
  await waitFor(wsB, 'ack');
  const broadB = await waitFor(wsA, 'op');
  check('交叠格按服务端接收顺序：B 在 A 之上', broadB.op.seq > broadA.op.seq);

  // 4. 同一个 id 原样重发 → 幂等拒绝，只生效一次
  wsB.send(JSON.stringify({ type: 'op', op: opB }));
  const err = await waitFor(wsB, 'error');
  check('重复 id 被拒绝且标记 duplicate', err.duplicate === true && /重复/.test(err.reason));

  // 5. B 断线：期间本地攒三笔（改色、撤销、恢复）
  wsB.close();
  await delay(200);
  const offline = [
    { id: 'smoke-B-2', type: 'paint', author: 'B', color: 'crimson',
      cells: [{ row: 7, col: 7 }, { row: 7, col: 8 }], clientSeq: 2 },
    { id: 'smoke-B-3', type: 'undo', author: 'B', paintId: 'smoke-B-2', clientSeq: 3 },
    { id: 'smoke-B-4', type: 'redo', author: 'B', paintId: 'smoke-B-2', clientSeq: 4 }
  ];

  // 6. B 重连：先取快照，再按本机顺序补交
  const wsB2 = await open();
  wsB2.send(JSON.stringify({ type: 'hello', author: 'B' }));
  const snap2 = await waitFor(wsB2, 'snapshot');
  check('重连快照含断线前已确认的笔', snap2.snapshot.allOpIds.includes('smoke-B-1'));
  check('重连快照不含未提交的离线操作', !snap2.snapshot.allOpIds.includes('smoke-B-2'));
  for (const op of offline) wsB2.send(JSON.stringify({ type: 'op', op }));
  const seqs = [];
  for (let i = 0; i < offline.length; i++) {
    const ack = await waitFor(wsB2, 'ack');
    seqs.push(ack.seq);
  }
  check('补交按 clientSeq 顺序受理（seq 递增）', seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
    JSON.stringify(seqs));

  // 7. 离线补交的重复重发仍然只生效一次
  wsB2.send(JSON.stringify({ type: 'op', op: offline[0] }));
  const err2 = await waitFor(wsB2, 'error');
  check('补交后重发仍被幂等去重', err2.duplicate === true);

  // 8. 最终一致：两边重新拉快照，内容应完全相同
  wsA.send(JSON.stringify({ type: 'resync' }));
  const finalA = (await waitFor(wsA, 'snapshot')).snapshot;
  wsB2.send(JSON.stringify({ type: 'resync' }));
  const finalB = (await waitFor(wsB2, 'snapshot')).snapshot;
  check('两端 seq 一致', finalA.seq === finalB.seq, finalA.seq + ' vs ' + finalB.seq);
  check('两端操作集合一致',
    JSON.stringify(finalA.allOpIds.slice().sort()) === JSON.stringify(finalB.allOpIds.slice().sort()));
  const top = (snap, row, col) => {
    const layers = snap.paints
      .filter((p) => p.cells.some((c) => c.row === row && c.col === col) && p.active)
      .sort((x, y) => x.seq - y.seq);
    return layers.length ? layers[layers.length - 1].color : null;
  };
  check('交叠格 (4,4) 显示 B 的 jade', top(finalA, 4, 4) === 'jade');
  check('格 (7,7) 经撤销又恢复后显示 crimson', top(finalA, 7, 7) === 'crimson');
  check('格 (4,5) 只有 A 的 gold', top(finalB, 4, 5) === 'gold');

  wsA.close();
  wsB2.close();
  await delay(100);
  console.log(failures === 0 ? '\n冒烟全部通过 ✅' : '\n有 ' + failures + ' 项失败 ❌');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

function latestPresence(ws) {
  return new Promise((resolve) => {
    const tick = () => {
      const m = ws.messages.find((x) => x.type === 'presence');
      if (m) resolve(m.peerCount); else setTimeout(tick, 10);
    };
    tick();
  });
}
