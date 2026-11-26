/* 双工位协同提花色格前端 */
(function () {
  'use strict';

  var G = JacquardPattern.GRID_SIZE;
  var session = null;
  var ws = null;
  var reconnectDelay = 500;
  var reconnectTimer = null;
  var stopped = false; // 同工位被顶掉后停止自动重连

  var canvas = document.getElementById('grid-canvas');
  var ctx = canvas.getContext('2d');
  var paletteEl = document.getElementById('palette');
  var currentColorEl = document.getElementById('current-color');
  var historyEl = document.getElementById('history');
  var cellInfoEl = document.getElementById('cell-info');
  var connDot = document.getElementById('conn-dot');
  var connText = document.getElementById('conn-text');
  var peerCountEl = document.getElementById('peer-count');
  var pendingCountEl = document.getElementById('pending-count');
  var resendBtn = document.getElementById('resend-btn');
  var picker = document.getElementById('picker');
  var errorToast = document.getElementById('error-toast');
  var toastTimer = null;

  var currentColor = JacquardPattern.PALETTE[0].id;
  var strokeCells = [];
  var strokeSeen = Object.create(null);
  var stroking = false;
  var hoverRC = null;

  /* ---------------- 工位与连接 ---------------- */

  function pickStation(station) {
    if (session) return;
    picker.classList.add('hidden');
    session = new SyncSession(station);
    session.onChange = renderAll;
    document.querySelectorAll('.station-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.station === station);
    });
    stopped = false;
    connect();
  }

  function connect() {
    if (!session || stopped) return;
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    ws = new WebSocket(url);

    ws.addEventListener('open', function () {
      reconnectDelay = 500;
      session.attach(ws); // hello + 快照对账/补交都在会话内完成
    });

    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      session.handleMessage(msg);
      if (msg.type === 'error' && !msg.duplicate) showError(msg.reason);
    });

    ws.addEventListener('close', function (ev) {
      if (session) session.markDisconnected();
      if (ev.code === 4002) {
        stopped = true;
        alert('本工位已在别处接入，此页面停止同步。请回到新标签操作，或重新选择工位。');
        session = null;
        picker.classList.remove('hidden');
        document.querySelectorAll('.station-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        draw(); // session 为空时回退渲染内置底图
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', function () {
      try { ws.close(); } catch (e) { /* ignore */ }
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
      connect();
    }, reconnectDelay);
  }

  /* ---------------- 配色盘 ---------------- */

  function buildPalette() {
    JacquardPattern.PALETTE.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'swatch' + (c.id === currentColor ? ' selected' : '');
      b.style.background = c.hex;
      b.dataset.color = c.id;
      b.innerHTML = '<span class="sw-name">' + c.name + '</span>';
      b.addEventListener('click', function () {
        currentColor = c.id;
        paletteEl.querySelectorAll('.swatch').forEach(function (x) {
          x.classList.toggle('selected', x.dataset.color === currentColor);
        });
        renderCurrentColor();
      });
      paletteEl.appendChild(b);
    });
    renderCurrentColor();
  }

  function renderCurrentColor() {
    var c = JacquardPattern.HEX_BY_ID[currentColor];
    currentColorEl.textContent = currentColor;
    currentColorEl.style.background = c;
  }

  /* ---------------- 画布与拖笔 ---------------- */

  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function cellSize() {
    return canvas.getBoundingClientRect().width / G;
  }

  function eventRC(ev) {
    var rect = canvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left);
    var y = (ev.clientY - rect.top);
    var s = rect.width / G;
    var col = Math.floor(x / s);
    var row = Math.floor(y / s);
    if (row < 0 || row >= G || col < 0 || col >= G) return null;
    return { row: row, col: col };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!session) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    stroking = true;
    strokeCells = [];
    strokeSeen = Object.create(null);
    addStrokeCell(eventRC(ev));
  });

  canvas.addEventListener('pointermove', function (ev) {
    var rc = eventRC(ev);
    hoverRC = rc;
    if (stroking) addStrokeCell(rc);
    draw();
    updateCellInfo();
  });

  canvas.addEventListener('pointerup', function (ev) {
    if (!stroking) return;
    ev.preventDefault();
    stroking = false;
    canvas.releasePointerCapture(ev.pointerId);
    if (strokeCells.length && session) {
      // 整笔多格作为一个操作提交；断线时进入 pending，重连自动补交
      session.makePaint(currentColor, strokeCells);
    }
    strokeCells = [];
    strokeSeen = Object.create(null);
    draw();
  });

  canvas.addEventListener('pointerleave', function () {
    hoverRC = null;
    updateCellInfo();
    draw();
  });

  function addStrokeCell(rc) {
    if (!rc) return;
    var key = rc.row + ',' + rc.col;
    if (strokeSeen[key]) return;
    strokeSeen[key] = true;
    strokeCells.push(rc);
    draw();
  }

  function draw() {
    var rect = canvas.getBoundingClientRect();
    var size = rect.width;
    var s = size / G;
    var grid = session ? session.viewGrid() : JacquardPattern.buildGrid();

    for (var r = 0; r < G; r++) {
      for (var c = 0; c < G; c++) {
        ctx.fillStyle = grid[r][c].hex;
        ctx.fillRect(c * s, r * s, s + 0.5, s + 0.5);
      }
    }

    // 正在拖的格子用当前画笔预览
    if (stroking) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = JacquardPattern.HEX_BY_ID[currentColor];
      strokeCells.forEach(function (rc) {
        ctx.fillRect(rc.col * s, rc.row * s, s, s);
      });
      ctx.globalAlpha = 1;
    }

    // 悬停描边
    if (hoverRC) {
      ctx.strokeStyle = '#c79a3a';
      ctx.lineWidth = 2;
      ctx.strokeRect(hoverRC.col * s + 1, hoverRC.row * s + 1, s - 2, s - 2);
    }

    // 格线
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    for (var i = 0; i <= G; i++) {
      ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(size, i * s); ctx.stroke();
    }
  }

  function updateCellInfo() {
    if (!hoverRC || !session) return;
    var stack = session.cellStack(hoverRC.row, hoverRC.col);
    var base = JacquardPattern.buildGrid()[hoverRC.row][hoverRC.col];
    var lines = ['格 (' + hoverRC.row + ',' + hoverRC.col + ') 底图=' + base.baseColor];
    if (!stack.length) {
      lines.push('无有效改色层，显示底图色');
    } else {
      lines.push('叠层（下层→上层）: ' + stack.map(function (p, i) {
        return '#' + (i + 1) + ' 工位' + p.author + '·' + p.color +
          (p.id && session.pending.some(function (q) { return q.id === p.id; }) ? '·待确认' : '');
      }).join(' / '));
    }
    cellInfoEl.textContent = lines.join('；');
  }

  /* ---------------- 笔迹面板（任意撤销/恢复） ---------------- */

  function renderHistory() {
    historyEl.innerHTML = '';
    if (!session) return;
    var items = session.history();
    if (!items.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有笔迹，拖一笔试试。';
      historyEl.appendChild(li);
      return;
    }
    items.forEach(function (p) {
      var li = document.createElement('li');
      var isPending = session.pending.some(function (q) {
        return q.type === 'paint' && q.id === p.id;
      });
      li.className = 'history-item' + (p.active ? '' : ' inactive') + (isPending ? ' pending' : '');

      var chip = document.createElement('span');
      chip.className = 'hi-chip';
      chip.style.background = JacquardPattern.HEX_BY_ID[p.color];

      var meta = document.createElement('span');
      meta.className = 'hi-meta';
      var label = p.color + ' · ' + p.cells.length + '格 · #' + p.seq +
        (isPending ? ' · 待确认' : '') + (p.active ? '' : ' · 已撤销');
      meta.innerHTML = label + '<br><small>' + p.id.slice(0, 8) + '</small>';

      var btn = document.createElement('button');
      btn.className = 'hi-toggle';
      btn.textContent = p.active ? '撤销' : '恢复';
      btn.addEventListener('click', function () {
        if (!session) return;
        session.makeToggle(p.id, p.active ? 'undo' : 'redo');
      });

      li.appendChild(chip);
      li.appendChild(meta);
      li.appendChild(btn);
      historyEl.appendChild(li);
    });
  }

  /* ---------------- 状态栏 ---------------- */

  function renderStatus() {
    if (!session) return;
    var on = session.connected;
    connDot.className = 'conn-dot ' + (on ? 'on' : 'off');
    connText.textContent = on ? '已连接' : '断线中（可继续操作，重连自动补交）';
    peerCountEl.textContent = session.peerCount;
    pendingCountEl.textContent = session.pending.length;
    resendBtn.disabled = session.pending.length === 0 || !on;
  }

  resendBtn.addEventListener('click', function () {
    if (session) session.resendPending();
  });

  function showError(text) {
    errorToast.textContent = '服务端提示：' + text;
    errorToast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      errorToast.classList.add('hidden');
    }, 4000);
  }

  function renderAll() {
    draw();
    renderHistory();
    renderStatus();
    updateCellInfo();
  }

  /* ---------------- 启动 ---------------- */

  document.querySelectorAll('[data-station]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      pickStation(btn.dataset.station);
    });
  });

  var param = new URLSearchParams(location.search).get('station');
  buildPalette();
  resizeCanvas();
  if (param === 'A' || param === 'B') pickStation(param);
})();
