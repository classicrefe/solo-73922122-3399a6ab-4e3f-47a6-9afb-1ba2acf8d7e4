/*
 * 客户端同步会话（浏览器与 Node 集成测试共用，UMD，传输无关）。
 *
 * 模型：
 *  - confirmed：服务端已确认的引擎状态（由 snapshot / op 维护）。
 *  - pending[]：本机已产生但未获确认的操作，按本机 clientSeq 升序；
 *    断线期间照常追加，重连收到 snapshot 后按顺序补交仍缺失的操作。
 *  - 显示态 = confirmed 之上按本机顺序叠加 pending（乐观显示）。
 *
 * 幂等：每个操作带全局唯一 id；服务端按 id 去重，重发只生效一次。
 * 重发触发：重新 attach 后收到 snapshot 时，凡 snapshot 中不存在的 pending 一律重发。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./pattern.js'));
  } else {
    root.SyncSession = factory(root.Engine, root.JacquardPattern);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine, Pattern) {
  'use strict';

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'op-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  function SyncSession(author) {
    this.author = author;
    this.confirmed = Engine.createInitialState();
    this.pending = [];
    this.clientSeq = 0;
    this.ws = null;
    this.connected = false;
    this.peerCount = 0;
    this.lastError = null;
    this.onChange = null; // 状态变化回调（UI 渲染用）
  }

  SyncSession.prototype._emit = function () {
    if (typeof this.onChange === 'function') this.onChange();
  };

  // 绑定一条新的 WebSocket（首连或重连），并发送 hello 索取全量快照
  SyncSession.prototype.attach = function (ws) {
    this.ws = ws;
    this.connected = true;
    this.lastError = null;
    this._send({ type: 'hello', author: this.author });
    this._emit();
  };

  SyncSession.prototype.markDisconnected = function () {
    this.connected = false;
    this.ws = null;
    this._emit();
  };

  SyncSession.prototype._send = function (msg) {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  // 本机产生一笔“改色”（整笔多格一起提交）；断线时也允许，进入 pending
  SyncSession.prototype.makePaint = function (color, cells) {
    // 去重 + 校验坐标
    var seen = Object.create(null);
    var clean = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!Number.isInteger(c.row) || !Number.isInteger(c.col)) continue;
      var key = c.row + ',' + c.col;
      if (seen[key]) continue;
      seen[key] = true;
      clean.push({ row: c.row, col: c.col });
    }
    if (!clean.length) throw new Error('一笔至少要改一格');
    if (!Object.prototype.hasOwnProperty.call(Pattern.HEX_BY_ID, color)) {
      throw new Error('未知色号: ' + color);
    }
    this.clientSeq += 1;
    var op = {
      id: uuid(),
      type: 'paint',
      author: this.author,
      color: color,
      cells: clean,
      clientSeq: this.clientSeq
    };
    this.pending.push(op);
    this._send({ type: 'op', op: op });
    this._emit();
    return op;
  };

  // 本机产生撤销/恢复操作
  SyncSession.prototype.makeToggle = function (paintId, kind) {
    if (kind !== 'undo' && kind !== 'redo') throw new Error('kind 必须是 undo/redo');
    this.clientSeq += 1;
    var op = {
      id: uuid(),
      type: kind,
      author: this.author,
      paintId: paintId,
      clientSeq: this.clientSeq
    };
    this.pending.push(op);
    this._send({ type: 'op', op: op });
    this._emit();
    return op;
  };

  // 处理服务端消息
  SyncSession.prototype.handleMessage = function (msg) {
    if (msg.type === 'snapshot') {
      this.confirmed = Engine.fromSnapshot(msg.snapshot);
      this.peerCount = msg.peerCount | 0;
      this._reconcilePending();
      this._emit();
    } else if (msg.type === 'op') {
      var op = msg.op;
      // 若是本机待确认的操作回来，先出队（确认态由引擎统一维护）
      var idx = this._pendingIndex(op.id);
      if (idx >= 0) this.pending.splice(idx, 1);
      if (!this.confirmed.allOpIds[op.id]) {
        Engine.applyOp(this.confirmed, op);
      }
      this.peerCount = msg.peerCount != null ? msg.peerCount : this.peerCount;
      this._emit();
    } else if (msg.type === 'ack') {
      // 静默出队：紧接的广播 op 才带完整记录，统一在那时渲染，避免一帧闪烁
      var ai = this._pendingIndex(msg.opId);
      if (ai >= 0) this.pending.splice(ai, 1);
    } else if (msg.type === 'error') {
      this.lastError = msg.reason || '服务端拒绝了操作';
      if (msg.duplicate && msg.opId) {
        // 重发命中幂等去重：服务端已有该操作，移除本地待确认并重新对账
        var di = this._pendingIndex(msg.opId);
        if (di >= 0) this.pending.splice(di, 1);
        this._send({ type: 'hello', author: this.author });
      }
      this._emit();
    } else if (msg.type === 'presence') {
      this.peerCount = msg.peerCount | 0;
      this._emit();
    }
  };

  SyncSession.prototype._pendingIndex = function (id) {
    for (var i = 0; i < this.pending.length; i++) {
      if (this.pending[i].id === id) return i;
    }
    return -1;
  };

  // 快照对账：已在快照里的 pending 移除；其余按本机 clientSeq 顺序重发
  SyncSession.prototype._reconcilePending = function () {
    var kept = [];
    for (var i = 0; i < this.pending.length; i++) {
      var op = this.pending[i];
      if (this.confirmed.allOpIds[op.id]) continue; // 已被服务端受理
      kept.push(op);
      this._send({ type: 'op', op: op });          // 补交（幂等，重发无害）
    }
    this.pending = kept;
  };

  // 手动触发重发（如应答超时由 UI 调用）
  SyncSession.prototype.resendPending = function () {
    for (var i = 0; i < this.pending.length; i++) {
      this._send({ type: 'op', op: this.pending[i] });
    }
  };

  // 显示态：确认态 + 待确认操作按本机顺序叠加
  SyncSession.prototype.viewState = function () {
    var state = Engine.fromSnapshot(Engine.toSnapshot(this.confirmed));
    for (var i = 0; i < this.pending.length; i++) {
      var op = this.pending[i];
      if (state.allOpIds[op.id]) continue;
      // 本地待确认操作跳过服务端校验直接叠加（本机已做过合法性检查）
      Engine.applyOp(state, op);
    }
    return state;
  };

  SyncSession.prototype.viewGrid = function () {
    return Engine.viewGrid(this.viewState());
  };

  SyncSession.prototype.history = function () {
    return Engine.historyForAuthor(this.viewState(), this.author);
  };

  SyncSession.prototype.cellStack = function (row, col) {
    return Engine.cellStack(this.viewState(), row, col);
  };

  return SyncSession;
});
