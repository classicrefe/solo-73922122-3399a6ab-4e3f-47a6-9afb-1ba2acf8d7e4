'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const Engine = require('../../shared/engine.js');
const Pattern = require('../../shared/pattern.js');

const STATIONS = ['A', 'B'];

function paint(id, author, color, cells, clientSeq) {
  return { id, type: 'paint', author, color, cells, clientSeq: clientSeq || 1 };
}
function toggle(id, author, paintId, kind, clientSeq) {
  return { id, type: kind, author, paintId, clientSeq: clientSeq || 1 };
}
function accept(state, op) {
  const check = Engine.validateOp(state, op, STATIONS);
  assert.ok(check.ok, '操作应通过校验: ' + check.reason);
  return Engine.applyOp(state, op);
}

describe('引擎：整笔改色与按服务端顺序叠色', () => {
  test('初始状态显示内置底图', () => {
    const s = Engine.createInitialState();
    assert.strictEqual(Engine.topColor(s, 0, 0), null);
    const grid = Engine.viewGrid(s);
    const base = Pattern.buildGrid();
    assert.strictEqual(grid[3][5].hex, base[3][5].hex);
    assert.strictEqual(grid.length, Pattern.GRID_SIZE);
  });

  test('两笔交叠同一格：先收的在下层，后收的在上层', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 1, col: 1 }, { row: 1, col: 2 }]));
    accept(s, paint('p2', 'B', 'jade', [{ row: 1, col: 1 }]));

    assert.strictEqual(Engine.topColor(s, 1, 1), 'jade'); // B 后到，在上
    assert.strictEqual(Engine.topColor(s, 1, 2), 'gold'); // 只有 A
    const stack = Engine.cellStack(s, 1, 1);
    assert.deepStrictEqual(stack.map((p) => p.id), ['p1', 'p2']);
    assert.strictEqual(s.seq, 2);
  });

  test('整笔多格一次性生效，不能半笔', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'plum', [{ row: 0, col: 0 }, { row: 0, col: 1 }]));
    assert.strictEqual(Engine.topColor(s, 0, 0), 'plum');
    assert.strictEqual(Engine.topColor(s, 0, 1), 'plum');
  });
});

describe('引擎：撤销露出下层、恢复回到原层位', () => {
  test('撤销上层笔露出下层仍有效颜色', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 2, col: 2 }]));
    accept(s, paint('p2', 'B', 'jade', [{ row: 2, col: 2 }]));
    accept(s, paint('p3', 'A', 'indigo', [{ row: 2, col: 2 }]));
    assert.strictEqual(Engine.topColor(s, 2, 2), 'indigo');

    accept(s, toggle('u1', 'A', 'p3', 'undo'));
    assert.strictEqual(Engine.topColor(s, 2, 2), 'jade'); // 露出 B 的下层
    assert.strictEqual(s.paints.p3.active, false);
    // 层序不变
    assert.deepStrictEqual(s.cellPaintIds[2][2], ['p1', 'p2', 'p3']);
  });

  test('恢复后回到原来的叠放位置，而不是压到最上', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 2, col: 2 }]));
    accept(s, paint('p2', 'B', 'jade', [{ row: 2, col: 2 }]));
    accept(s, paint('p3', 'A', 'indigo', [{ row: 2, col: 2 }]));
    accept(s, toggle('u1', 'A', 'p3', 'undo'));
    // p3 撤销期间又来一笔，位于最上
    accept(s, paint('p4', 'B', 'crimson', [{ row: 2, col: 2 }]));
    assert.strictEqual(Engine.topColor(s, 2, 2), 'crimson');

    accept(s, toggle('r1', 'A', 'p3', 'redo'));
    assert.strictEqual(s.paints.p3.active, true);
    assert.deepStrictEqual(s.cellPaintIds[2][2], ['p1', 'p2', 'p3', 'p4']);
    assert.strictEqual(Engine.topColor(s, 2, 2), 'crimson'); // p3 仍在 p4 之下
  });

  test('撤销自己唯一一笔后显示底图色', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 5, col: 5 }]));
    accept(s, toggle('u1', 'A', 'p1', 'undo'));
    assert.strictEqual(Engine.topColor(s, 5, 5), null);
    assert.strictEqual(Engine.cellStack(s, 5, 5).length, 0);
  });

  test('不能撤销/恢复别人的笔', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 5, col: 5 }]));
    const check = Engine.validateOp(
      s, toggle('u1', 'B', 'p1', 'undo'), STATIONS
    );
    assert.strictEqual(check.ok, false);
  });
});

describe('引擎：幂等与校验', () => {
  test('相同操作 id 重发只生效一次', () => {
    const s = Engine.createInitialState();
    const op = paint('dup1', 'A', 'gold', [{ row: 7, col: 7 }]);
    accept(s, op);
    const again = Engine.validateOp(s, op, STATIONS);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(s.seq, 1);
  });

  test('越界坐标、空笔、未知色号被拒绝', () => {
    const s = Engine.createInitialState();
    assert.strictEqual(Engine.validateOp(s, paint('x', 'A', 'gold', []), STATIONS).ok, false);
    assert.strictEqual(
      Engine.validateOp(s, paint('x', 'A', 'gold', [{ row: 99, col: 0 }]), STATIONS).ok, false
    );
    assert.strictEqual(
      Engine.validateOp(s, paint('x', 'A', 'nope', [{ row: 0, col: 0 }]), STATIONS).ok, false
    );
    assert.strictEqual(
      Engine.validateOp(s, paint('x', 'C', 'gold', [{ row: 0, col: 0 }]), STATIONS).ok, false
    );
  });

  test('快照往返后状态等价', () => {
    const s = Engine.createInitialState();
    accept(s, paint('p1', 'A', 'gold', [{ row: 1, col: 1 }]));
    accept(s, paint('p2', 'B', 'jade', [{ row: 1, col: 1 }]));
    accept(s, toggle('u1', 'A', 'p1', 'undo'));
    const restored = Engine.fromSnapshot(Engine.toSnapshot(s));
    assert.strictEqual(restored.seq, s.seq);
    assert.strictEqual(Engine.topColor(restored, 1, 1), 'jade');
    assert.deepStrictEqual(restored.cellPaintIds[1][1], ['p1', 'p2']);
    assert.strictEqual(restored.paints.p1.active, false);
  });
});
