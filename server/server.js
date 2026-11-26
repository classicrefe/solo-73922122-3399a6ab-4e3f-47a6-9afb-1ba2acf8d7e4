/*
 * 协同提花色格服务端。
 * - Node 内置 http 提供静态页面；ws 提供 WebSocket。
 * - 全局只有一份引擎状态：操作按服务端“首次收下”的顺序分配 seq 并生效，
 *   同格多笔按 seq 叠色。
 * - 每个操作带唯一 id：重复提交拒绝（duplicate），保证重发只生效一次。
 * - 重连/首连发送全量 snapshot，客户端据此对账并按本机顺序补交未确认操作。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Engine = require('../shared/engine.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const STATIONS = ['A', 'B'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const state = Engine.createInitialState();
const clients = new Map(); // station -> ws

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seq: state.seq, peers: clients.size }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // 只允许 public 与 shared 下的白名单路径，禁止目录穿越
  let baseDir;
  if (rel.startsWith('/shared/')) baseDir = SHARED_DIR;
  else baseDir = PUBLIC_DIR;
  const filePath = path.normalize(path.join(baseDir, rel.replace(/^\/(shared\/)?/, '')));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  serveFile(res, filePath);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function peerCount() {
  return clients.size;
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.station = null;
  ws.on('pong', () => { ws.isAlive = true; });

  const helloTimer = setTimeout(() => {
    if (ws.station === null) {
      closeWith(ws, 4000, '未在规定时间内选择工位');
    }
  }, 10000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      send(ws, { type: 'error', reason: '消息不是合法 JSON' });
      return;
    }

    if (msg.type === 'hello') {
      const author = String(msg.author || '');
      if (!STATIONS.includes(author)) {
        send(ws, { type: 'error', reason: '工位必须是 A 或 B' });
        closeWith(ws, 4000, '非法工位');
        return;
      }
      // 同工位新连接顶掉旧连接（浏览器刷新/快速重连场景）
      const old = clients.get(author);
      if (old && old !== ws && old.readyState === old.OPEN) {
        closeWith(old, 4002, '同工位在别处接入，旧连接已关闭');
      }
      clearTimeout(helloTimer);
      ws.station = author;
      clients.set(author, ws);
      send(ws, {
        type: 'snapshot',
        snapshot: Engine.toSnapshot(state),
        peerCount: peerCount()
      });
      broadcast({ type: 'presence', peerCount: peerCount() });
      return;
    }

    if (ws.station === null) {
      send(ws, { type: 'error', reason: '请先发送 hello 选择工位' });
      return;
    }

    if (msg.type === 'op') {
      const op = msg.op;
      if (!op || typeof op !== 'object') {
        send(ws, { type: 'error', reason: '操作格式错误' });
        return;
      }
      // 工位身份以连接为准，不信任报文里的 author
      op.author = ws.station;
      const check = Engine.validateOp(state, op, STATIONS);
      if (!check.ok) {
        send(ws, {
          type: 'error',
          opId: op.id,
          duplicate: !!check.duplicate,
          reason: check.reason
        });
        return;
      }
      const record = Engine.applyOp(state, op); // 整笔一起生效，分配全局 seq
      send(ws, { type: 'ack', opId: record.id, seq: record.seq });
      broadcast({ type: 'op', op: record, peerCount: peerCount() });
      return;
    }

    if (msg.type === 'resync') {
      send(ws, {
        type: 'snapshot',
        snapshot: Engine.toSnapshot(state),
        peerCount: peerCount()
      });
      return;
    }

    send(ws, { type: 'error', reason: '未知消息类型: ' + msg.type });
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (ws.station && clients.get(ws.station) === ws) {
      clients.delete(ws.station);
      broadcast({ type: 'presence', peerCount: peerCount() });
    }
  });

  ws.on('error', () => { /* 由 close 统一清理 */ });
});

function closeWith(ws, code, reason) {
  try { ws.close(code, reason); } catch (_) { /* ignore */ }
}

// 心跳：清理断连但未触发 close 的连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`提花协同演示已启动: http://localhost:${PORT}  (WebSocket 路径 /ws)`);
});

module.exports = { server, wss, state };
