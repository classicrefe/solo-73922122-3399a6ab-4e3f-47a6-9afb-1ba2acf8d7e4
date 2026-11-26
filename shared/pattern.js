/*
 * 内置提花色格底图（浏览器与 Node 共用，UMD）。
 * 色格为 GRID_SIZE x GRID_SIZE，每个格子带一个基础色 baseColor，
 * 服务端与浏览器都从这份纯函数数据初始化，保证“同一张内置图”。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JacquardPattern = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GRID_SIZE = 24;

  // 提花配色盘（两位织样师改色都只能选这组色号）
  var PALETTE = [
    { id: 'indigo',  name: '靛青', hex: '#273b5e' },
    { id: 'crimson', name: '绛红', hex: '#8e2f3b' },
    { id: 'gold',    name: '赭金', hex: '#c79a3a' },
    { id: 'jade',    name: '松石', hex: '#3f8f7d' },
    { id: 'plum',    name: '梅紫', hex: '#6b4a78' },
    { id: 'ivory',   name: '牙白', hex: '#efe6cf' },
    { id: 'slate',   name: '黛灰', hex: '#5c6670' },
    { id: 'teal',    name: '黛蓝', hex: '#2f6f7e' }
  ];

  var HEX_BY_ID = PALETTE.reduce(function (m, c) { m[c.id] = c.hex; return m; }, {});

  function colorAt(r, c) {
    // 提花格：宽/窄条带 + 菱格点缀，对称布局
    var bandR = (r % 8 === 0 || r % 8 === 1) ? 'indigo'
              : (r % 8 === 4) ? 'crimson' : 'ivory';
    var bandC = (c % 8 === 0 || c % 8 === 1) ? 'indigo'
              : (c % 8 === 4) ? 'crimson' : 'ivory';
    var id;
    if (bandR === 'indigo' || bandC === 'indigo') id = 'indigo';
    else if (bandR === 'crimson' && bandC === 'crimson') id = 'gold';
    else if (bandR === 'crimson' || bandC === 'crimson') id = 'crimson';
    else if ((r + c) % 6 === 0) id = 'jade';
    else if (Math.abs(r - c) % 10 === 0) id = 'plum';
    else id = 'ivory';
    return { row: r, col: c, baseColor: id, hex: HEX_BY_ID[id] };
  }

  function buildGrid() {
    var grid = [];
    for (var r = 0; r < GRID_SIZE; r++) {
      var row = [];
      for (var c = 0; c < GRID_SIZE; c++) row.push(colorAt(r, c));
      grid.push(row);
    }
    return grid;
  }

  return {
    GRID_SIZE: GRID_SIZE,
    PALETTE: PALETTE,
    HEX_BY_ID: HEX_BY_ID,
    buildGrid: buildGrid
  };
});
