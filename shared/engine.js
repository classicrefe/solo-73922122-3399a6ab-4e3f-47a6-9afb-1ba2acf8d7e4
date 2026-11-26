/*
 * 协同色格状态引擎（浏览器与 Node 共用，UMD，纯函数式）。
 *
 * 关键规则：
 *  - 服务端按“首次收下”的顺序给每笔操作分配 seq；同一格上的多笔 paint 按 seq 叠色，
 *    最上层有效笔决定显示色。
 *  - 撤销/恢复只切换 paint 的 active 标志，绝不改变它在叠层中的 seq 位置；
 *    撤销后露出下层仍有效的颜色，恢复时回到原来的叠放位置。
 *  - 每个操作带唯一 id，已受理的 id 再次提交会被拒绝（重发只生效一次）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./pattern.js'));
  } else {
    root.Engine = factory(root.JacquardPattern);
  }
})(typeof self !== 'undefined' ? self : this, function (Pattern) {
  'use strict';

  var GRID_SIZE = Pattern.GRID_SIZE;

  function createInitialState() {
    var cellPaintIds = [];
    for (var r = 0; r < GRID_SIZE; r++) {
      cellPaintIds.push(new Array(GRID_SIZE).fill(null).map(function () { return []; }));
    }
    return {
      seq: 0,
      paints: {},       // paintId -> paint 记录（含 active、seq）
      undoOps: {},      // 撤销/恢复操作 id -> 记录
      allOpIds: {},     // 所有已受理操作 id -> true（幂等去重）
      cellPaintIds: cellPaintIds // 每格的 paintId 列表，按 seq 升序
    };
  }

  function isId(s) {
    return typeof s === 'string' && s.length > 0 && s.length <= 128;
  }

  function inBounds(r, c) {
    return Number.isInteger(r) && Number.isInteger(c) &&
      r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE;
  }

  // 校验操作；stations 为允许的工位 id 列表。返回 { ok:true } 或 { ok:false, reason }
  function validateOp(state, op, stations) {
    if (!op || typeof op !== 'object') return { ok: false, reason: '操作不是对象' };
    if (!isId(op.id)) return { ok: false, reason: '缺少操作 id' };
    if (state.allOpIds[op.id]) return { ok: false, reason: '重复的操作 id', duplicate: true };
    if (stations.indexOf(op.author) < 0) return { ok: false, reason: '未知工位: ' + op.author };
    if (op.type === 'paint') return validatePaint(state, op);
    if (op.type === 'undo' || op.type === 'redo') return validateToggle(state, op);
    return { ok: false, reason: '未知操作类型: ' + op.type };
  }

  function validatePaint(state, op) {
    if (!Object.prototype.hasOwnProperty.call(Pattern.HEX_BY_ID, op.color)) {
      return { ok: false, reason: '未知色号: ' + op.color };
    }
    if (!Array.isArray(op.cells) || op.cells.length === 0) {
      return { ok: false, reason: '一笔至少要改一格' };
    }
    var seen = Object.create(null);
    for (var i = 0; i < op.cells.length; i++) {
      var cell = op.cells[i];
      if (!cell || !inBounds(cell.row, cell.col)) {
        return { ok: false, reason: '格子坐标越界' };
      }
      var key = cell.row + ',' + cell.col;
      if (seen[key]) return { ok: false, reason: '同一笔内出现重复格' };
      seen[key] = true;
    }
    return { ok: true };
  }

  function validateToggle(state, op) {
    if (!isId(op.paintId)) return { ok: false, reason: '缺少 paintId' };
    var paint = state.paints[op.paintId];
    if (!paint) return { ok: false, reason: '目标笔不存在: ' + op.paintId };
    if (paint.author !== op.author) {
      return { ok: false, reason: '只能撤销/恢复自己的笔' };
    }
    if (op.type === 'undo' && !paint.active) {
      return { ok: false, reason: '该笔已经是撤销状态' };
    }
    if (op.type === 'redo' && paint.active) {
      return { ok: false, reason: '该笔已经是有效状态' };
    }
    return { ok: true };
  }

  // 受理一笔已校验通过的操作，分配 seq 并更新状态
  function applyOp(state, op) {
    state.seq += 1;
    state.allOpIds[op.id] = true;
    if (op.type === 'paint') {
      var record = {
        id: op.id,
        type: 'paint',
        author: op.author,
        color: op.color,
        cells: op.cells.map(function (c) { return { row: c.row, col: c.col }; }),
        clientSeq: Number.isInteger(op.clientSeq) ? op.clientSeq : null,
        seq: state.seq,
        active: true
      };
      state.paints[op.id] = record;
      record.cells.forEach(function (cell) {
        state.cellPaintIds[cell.row][cell.col].push(op.id);
      });
      return record;
    }
    // undo / redo
    var paint = state.paints[op.paintId];
    paint.active = (op.type === 'redo');
    state.undoOps[op.id] = {
      id: op.id,
      type: op.type,
      author: op.author,
      paintId: op.paintId,
      clientSeq: Number.isInteger(op.clientSeq) ? op.clientSeq : null,
      seq: state.seq
    };
    return state.undoOps[op.id];
  }

  // 某一格上的叠层：返回有效 paint 记录，seq 升序（最上层在末尾）
  function cellStack(state, row, col) {
    return state.cellPaintIds[row][col]
      .map(function (id) { return state.paints[id]; })
      .filter(function (p) { return p && p.active; });
  }

  // 某一格当前显示色号：最上层有效笔，否则为 null（调用方回退到底图基础色）
  function topColor(state, row, col) {
    var stack = cellStack(state, row, col);
    return stack.length ? stack[stack.length - 1].color : null;
  }

  // 整图显示色（hex），用于渲染
  function viewGrid(state) {
    var grid = Pattern.buildGrid();
    for (var r = 0; r < GRID_SIZE; r++) {
      for (var c = 0; c < GRID_SIZE; c++) {
        var top = topColor(state, r, c);
        if (top) grid[r][c].hex = Pattern.HEX_BY_ID[top];
      }
    }
    return grid;
  }

  // 某位织样师自己的笔，按受理 seq 升序；带 active 与当前可切换状态
  function historyForAuthor(state, author) {
    return Object.keys(state.paints)
      .map(function (id) { return state.paints[id]; })
      .filter(function (p) { return p.author === author; })
      .sort(function (a, b) { return a.seq - b.seq; });
  }

  // 生成可序列化快照（重连后对账用）
  function toSnapshot(state) {
    return {
      seq: state.seq,
      paints: Object.keys(state.paints).map(function (id) { return state.paints[id]; }),
      undoOps: Object.keys(state.undoOps).map(function (id) { return state.undoOps[id]; }),
      allOpIds: Object.keys(state.allOpIds)
    };
  }

  function fromSnapshot(snap) {
    var state = createInitialState();
    state.seq = snap.seq | 0;
    snap.allOpIds.forEach(function (id) { state.allOpIds[id] = true; });
    snap.paints.forEach(function (p) { state.paints[p.id] = p; });
    snap.undoOps.forEach(function (u) { state.undoOps[u.id] = u; });
    // 重建每格叠层并按 seq 排序
    Object.keys(state.paints).forEach(function (id) {
      var p = state.paints[id];
      p.cells.forEach(function (cell) {
        state.cellPaintIds[cell.row][cell.col].push(id);
      });
    });
    for (var r = 0; r < GRID_SIZE; r++) {
      for (var c = 0; c < GRID_SIZE; c++) {
        state.cellPaintIds[r][c].sort(function (a, b) {
          return state.paints[a].seq - state.paints[b].seq;
        });
      }
    }
    return state;
  }

  return {
    GRID_SIZE: GRID_SIZE,
    createInitialState: createInitialState,
    validateOp: validateOp,
    applyOp: applyOp,
    cellStack: cellStack,
    topColor: topColor,
    viewGrid: viewGrid,
    historyForAuthor: historyForAuthor,
    toSnapshot: toSnapshot,
    fromSnapshot: fromSnapshot
  };
});
