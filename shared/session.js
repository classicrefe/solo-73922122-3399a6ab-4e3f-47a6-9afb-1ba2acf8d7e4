/*
 * 客户端同步会话（浏览器与 Node 集成测试共用，UMD，传输无关）。
 *
 * 模型：
 *  - confirmed：服务端已确认的引擎状态（由 snapshot / op 维护）。
 *  - pending[]：本机已产生但未获完整确认的操作，按本机 clientSeq 升序；
 *    断线期间照常追加，重连收到 snapshot 后按顺序补交仍缺失的操作。
 *  - 显示态 = confirmed 之上按本机顺序叠加 pending（乐观显示）。
 *
 * 发送顺序保证（重连修复核心）：
 *  - 每条连接在收到服务端全量 snapshot 并完成对账之前是“关闸”状态，
 *    此期间产生的任何操作（含断线遗留的待交操作）只排队、不发线；
 *    开闸后 _flush 按 pending 的本机顺序依次发出，因此“先产生的先到服务端”，
 *    等快照时新落笔的操作绝不会插到断线待交操作前面。
 *  - 手动“重发待确认”走同一个 _flush 队列，同样不能插队；重复 id 由服务端幂等去重。
 *
 * 回执先到不回退（重连修复核心）：
 *  - ack 只把 pending 项标记为 acked，不立即出队；乐观视图继续包含它，
 *    直到携带完整记录的广播 op 到达才移除，避免“回执先于笔迹更新”时本地重绘闪回旧色。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./pattern.js'));
  } else {
    root.SyncSession = factory(root.Engine, root.JacquardPattern);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine, Pattern) {
  'use strict';

  var SNAPSHOT_TIMEOUT_MS = 5000;

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
    this.gateOpen = false; // 当前连接是否已收到快照并完成对账（开闸）
    this.peerCount = 0;
    this.lastError = null;
    this.onChange = null; // 状态变化回调（UI 渲染用）
    this._snapshotTimer = null;
  }

  SyncSession.prototype._emit = function () {
    if (typeof this.onChange === 'function') this.onChange();
  };

  // 绑定一条新的 WebSocket（首连或重连）：关闸并发送 hello 索取全量快照
  SyncSession.prototype.attach = function (ws) {
    this.ws = ws;
    this.connected = true;
    this.gateOpen = false;
    this.lastError = null;
    this._clearSnapshotTimer();
    this._send({ type: 'hello', author: this.author });
    // 快照迟迟不到则主动 resync 索账，避免闸门永久关闭导致待交操作发不出去
    this._snapshotTimer = setTimeout(this._onSnapshotTimeout.bind(this), SNAPSHOT_TIMEOUT_MS);
    this._emit();
  };

  SyncSession.prototype.markDisconnected = function () {
    this.connected = false;
    this.gateOpen = false;
    this.ws = null;
    this._clearSnapshotTimer();
    // 连接已断：此前任何“已发/已 ack”标记都不再可信，重连开闸后需要整体重发对账
    for (var i = 0; i < this.pending.length; i++) {
      this.pending[i]._sent = false;
      this.pending[i]._acked = false;
    }
    this._emit();
  };

  SyncSession.prototype._clearSnapshotTimer = function () {
    if (this._snapshotTimer) {
      clearTimeout(this._snapshotTimer);
      this._snapshotTimer = null;
    }
  };

  SyncSession.prototype._onSnapshotTimeout = function () {
    if (!this.connected || this.gateOpen) return;
    this._send({ type: 'resync' });
    this._snapshotTimer = setTimeout(this._onSnapshotTimeout.bind(this), SNAPSHOT_TIMEOUT_MS);
  };

  // 控制类消息（hello/resync）直接发；业务 op 一律走 _flush 排队
  SyncSession.prototype._send = function (msg) {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  // 剥掉仅本机会话使用的下划线字段，再按当前 pending 顺序发线
  SyncSession.prototype._sendOp = function (op) {
    var wire = {
      id: op.id,
      type: op.type,
      author: op.author,
      clientSeq: op.clientSeq
    };
    if (op.type === 'paint') {
      wire.color = op.color;
      wire.cells = op.cells;
    } else {
      wire.paintId = op.paintId;
    }
    return this._send({ type: 'op', op: wire });
  };

  // 按本机 clientSeq 顺序把待确认操作发出去；关闸（未对账）时一律不发。
  // 手动重发也走这里：从头扫描，已在本连接发出的跳过，绝不允许后产生的操作插队。
  SyncSession.prototype._flush = function () {
    if (!this.connected || !this.gateOpen) return;
    for (var i = 0; i < this.pending.length; i++) {
      var op = this.pending[i];
      if (op._sent) continue;
      if (this._sendOp(op)) op._sent = true;
      else break; // 发送失败（连接已断），保持顺序等待下次开闸整体补交
    }
  };

  // 本机产生一笔“改色”（整笔多格一起提交）；断线/等快照时也允许，进入 pending
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
      clientSeq: this.clientSeq,
      _sent: false,
      _acked: false
    };
    this.pending.push(op);
    this._flush();
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
      clientSeq: this.clientSeq,
      _sent: false,
      _acked: false
    };
    this.pending.push(op);
    this._flush();
    this._emit();
    return op;
  };

  // 处理服务端消息
  SyncSession.prototype.handleMessage = function (msg) {
    if (msg.type === 'snapshot') {
      this.confirmed = Engine.fromSnapshot(msg.snapshot);
      this.peerCount = msg.peerCount | 0;
      this._reconcilePending();
      this._clearSnapshotTimer();
      this.gateOpen = true;   // 对账完成才开闸
      this._flush();          // 开闸后按本机顺序补交仍缺失的操作
      this._emit();
    } else if (msg.type === 'op') {
      var op = msg.op;
      // 只有携带完整记录的广播到达，才把本机待确认项真正出队
      var idx = this._pendingIndex(op.id);
      if (idx >= 0) this.pending.splice(idx, 1);
      if (!this.confirmed.allOpIds[op.id]) {
        Engine.applyOp(this.confirmed, op);
      }
      this.peerCount = msg.peerCount != null ? msg.peerCount : this.peerCount;
      this._emit();
    } else if (msg.type === 'ack') {
      // 仅标记，不出队：广播 op 可能还在路上，出队会让乐观视图闪回旧色。
      // 保留在 pending 里继续参与乐观渲染，直到对应广播到达。
      var ai = this._pendingIndex(msg.opId);
      if (ai >= 0) this.pending[ai]._acked = true;
    } else if (msg.type === 'error') {
      this.lastError = msg.reason || '服务端拒绝了操作';
      if (msg.duplicate && msg.opId) {
        // 重发命中幂等去重：服务端已有该操作。先尝试把其效果补进本地确认态，
        // 再从待确认队列移除并重新索账，全程不回退显示颜色；
        // 若本地还无法应用（如撤销的目标笔尚未到达），保留在队列等快照裁决。
        var di = this._pendingIndex(msg.opId);
        if (di >= 0) {
          var dup = this.pending[di];
          var applied = this.confirmed.allOpIds[dup.id];
          if (!applied) {
            try {
              Engine.applyOp(this.confirmed, dup);
              applied = true;
            } catch (e) {
              applied = false;
            }
          }
          if (applied) this.pending.splice(di, 1);
        }
        this._send({ type: 'resync' });
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

  // 快照对账：已在快照里的 pending 移除；其余保留，由 _flush 按本机顺序重发
  SyncSession.prototype._reconcilePending = function () {
    var kept = [];
    for (var i = 0; i < this.pending.length; i++) {
      var op = this.pending[i];
      if (this.confirmed.allOpIds[op.id]) continue; // 已被服务端受理，等广播或下轮快照
      op._sent = false;
      op._acked = false;
      kept.push(op);
    }
    this.pending = kept;
  };

  // 手动触发重发（如应答超时由 UI 调用）：走同一个按序队列，不能插队
  SyncSession.prototype.resendPending = function () {
    for (var i = 0; i < this.pending.length; i++) {
      this.pending[i]._sent = false;
    }
    this._flush();
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
