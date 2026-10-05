'use strict';
/* ================================================================
   政点 · 桌面应用内核
   这里做的事：窗口、原生菜单、系统文件对话框、磁盘自动备份。
   渲染层仍然是那份单文件界面，但它不再跑在浏览器里。
   ================================================================ */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Chromium 会拒收它不认识的双横线开关，所以测试模式走环境变量
const SMOKE = process.env.ORIGIN_SMOKE === '1' || process.argv.includes('--smoke');
/* 批量导入：把清单里列的文档灌进知识库。和 SMOKE 不一样 ——
   SMOKE 故意把数据目录挪到临时位置做隔离，导入要写进真实数据目录。 */
const IMPORT = process.env.ORIGIN_IMPORT === '1';
const IMPORT_MANIFEST = process.env.ORIGIN_IMPORT_MANIFEST || '';
/* 体检：把库里真实的状态摊出来看，只读不写。用来回答"到底落盘了没有"。 */
const KBSTAT = process.env.ORIGIN_KBSTAT === '1';
const KBSTAT_OUT = process.env.ORIGIN_KBSTAT_OUT || path.join(require('os').tmpdir(), 'origin-kbstat.json');
/* 知识库清单重建：磁盘上有资料文件、库里却没记录时用它救回来。 */
const KBRESTORE = process.env.ORIGIN_KBRESTORE === '1';
const SHOTS = process.env.ORIGIN_SHOTS === '1';
/* 截图落到哪里。默认是系统临时目录 —— 但那个目录随时可能被系统清掉，
   调试时用 ORIGIN_SHOTS_DIR 指到构建目录里，拍完马上就能看。 */
const SHOTS_DIR = process.env.ORIGIN_SHOTS_DIR || app.getPath('temp');
/* 截图用的视口。默认桌面尺寸；给个窄的（比如 390x844）就按手机来拍 ——
   手机版不是"把桌面缩小"，得用真实视口看才作数。 */
const SHOT_SIZE = process.env.ORIGIN_SHOT_SIZE || '1440x940';
const SHOT_W = parseInt(SHOT_SIZE.split('x')[0], 10) || 1440;
const SHOT_H = parseInt(SHOT_SIZE.split('x')[1], 10) || 940;
const MOBILE_SHOT = SHOT_W <= 900;

/* ── 兼容性开关：目标是"在任何机器上都打得开" ──
   1) --disable-gpu-sandbox
      在受限环境里（远程桌面、虚拟机、公司策略、某些安全软件），Chromium 自带的
      GPU 进程沙箱会起不来。GPU 进程反复崩溃后 Chromium 会直接
      "GPU process isn't usable. Goodbye." 退出 —— 用户看到的现象是"双击了没反应"。
      这个开关只关 GPU 进程那一层沙箱，渲染进程的沙箱不动。
   2) ORIGIN_NOGPU=1
      退回纯软件渲染。给显卡驱动有问题的机器留着当后路。 */
app.commandLine.appendSwitch('disable-gpu-sandbox');
/* 画质：这三条是给"看起来发虚"准备的。
   - enable-lcd-text：软件渲染路径下也按次像素画文字，中文笔画更锐
   - force-color-profile=srgb：显示器色彩配置不对时界面会发灰发淡，锁回 srgb
   显卡正常的机器仍走硬件加速，这两条只在纯软件路径上起作用，开着无害。 */
app.commandLine.appendSwitch('enable-lcd-text');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (process.env.ORIGIN_NOGPU === '1') app.disableHardwareAcceleration();

/* 追踪日志：出问题时我要知道它走到哪一步了，而不是对着一片空白猜。
   路径由 ORIGIN_TRACE 指定（可选）。 */
const TRACE_FILE = process.env.ORIGIN_TRACE || path.join(require('os').tmpdir(), 'origin-trace.log');
function trace(s) {
  try { require('fs').appendFileSync(TRACE_FILE, new Date().toISOString() + '  ' + s + '\n'); } catch (e) {}
}
process.on('uncaughtException', e => {
  trace('UNCAUGHT  ' + (e && e.stack || e));
  try { if (SMOKE) require('electron').app.exit(1); } catch (err) {}
});
process.on('unhandledRejection', e => trace('UNHANDLED ' + (e && e.stack || e)));
trace('--- 进程启动 ' + process.execPath);
/* 纯离线精简版开关：resources/app 里放一个 pure.flag 就是精简版 ——
   菜单去掉「六艺」和整个「模型」，界面侧由 index.html 里的
   window.ZD_PURE 收起同样的东西。两份 exe 共用这一份 main.js。 */
const PURE = fs.existsSync(path.join(__dirname, 'pure.flag'));
const APP_NAME = PURE ? '政点 纯离线版' : '政点';
const VERSION = '3.0.0';

/* ---------- 数据位置 ----------
   便携优先：能写就写在程序旁边，这样整个文件夹复制走，数据跟着走。
   写不进去（比如被放到只读目录）就退回系统用户目录。 */
const EXE_DIR = path.dirname(process.execPath);
const IS_PORTABLE_LAYOUT = path.basename(process.execPath).toLowerCase() !== 'electron.exe'
  && fs.existsSync(path.join(EXE_DIR, 'resources', 'app'));

function pickDataDir() {
  // 冒烟测试永远用临时目录，绝不允许碰到真实数据（这一条必须在最前面）
  if (SMOKE) return path.join(app.getPath('temp'), 'zhengdian-smoke-' + Date.now());
  /* 高级开关：把数据目录指到别处。调试、或者想在别的盘上跑真实数据时用。
     不设这个环境变量就完全按下面的规则走。 */
  if (process.env.ORIGIN_DATA_DIR) return process.env.ORIGIN_DATA_DIR;
  if (!IS_PORTABLE_LAYOUT) return path.join(app.getPath('appData'), '政点');
  const fresh = path.join(EXE_DIR, '政点-数据');
  const legacy = path.join(EXE_DIR, 'ORIGIN-数据');
  /* 一次性的改名迁移：同一个盘上 rename 是瞬时操作，数据一个字节都不动。
     政点-数据 还不存在、旧的 ORIGIN-数据 在 —— 就把旧目录整个改名接上来。
     rename 失败（目录被资源管理器占用、跨盘等）就原地沿用旧目录，
     宁可目录名不改，也不能让任何记录落空。 */
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, fresh);
      trace('数据目录已迁移：ORIGIN-数据 → 政点-数据');
    } catch (e) {
      trace('数据目录改名失败，沿用旧目录：' + ((e && e.message) || e));
      return legacy;
    }
  }
  try {
    fs.mkdirSync(fresh, { recursive: true });
    const probe = path.join(fresh, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return fresh;
  } catch (e) {
    return path.join(app.getPath('appData'), '政点');
  }
}

const DATA_DIR = pickDataDir();
const AUTOSAVE_DIR = path.join(DATA_DIR, '自动备份');
const AUTOSAVE_FILE = path.join(AUTOSAVE_DIR, '最近一次.json');
const STATE_FILE = path.join(DATA_DIR, 'window.json');
const KB_DIR = path.join(DATA_DIR, '知识库');
const KB_FILES_DIR = path.join(KB_DIR, '原文');
const KB_INDEX_DIR = path.join(KB_DIR, '索引');
const AI_CFG_FILE = path.join(DATA_DIR, 'AI配置.json');
app.setPath('userData', path.join(DATA_DIR, '运行数据'));
trace('数据目录 ' + DATA_DIR + '（便携=' + IS_PORTABLE_LAYOUT + '）');

/* ---------- 小工具 ---------- */
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes());
}

/* ---------- 窗口状态 ---------- */
const DEFAULT_BOUNDS = { width: 1440, height: 940, maximized: false };
function loadBounds() {
  const b = readJSON(STATE_FILE, null);
  if (b && b.width >= 900 && b.height >= 600) return b;
  return Object.assign({}, DEFAULT_BOUNDS);
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  writeJSON(STATE_FILE, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
}

/* ---------- 自动备份 ----------

   这里要解决的是一个真实会掉的坑：有些盘（U 盘、网盘同步目录、只读挂载、
   安全软件接管的目录）**不让你覆盖已经存在的文件** —— 覆盖写会直接 EPERM。
   在这种盘上，"每次都写同一个文件名"的存盘方式等于没存：文件永远不会更新，
   而进程里读回来的又是内存副本，看起来一切正常，重启才发现记录全没了。

   所以真正靠得住的那一份，写成**每次一个新文件**：
     自动备份/快照-<版本号>-<时间戳>.json
   只依赖"能新建文件"这一条最弱的权限。窗口里那份 最近一次.json 继续写，
   给人看、也给别的功能读，写不进去也不算失败。 */
const SNAP_PREFIX = '快照-';
const SNAP_KEEP = 12;

function snapRevOf(text) {
  try {
    const j = JSON.parse(text);
    const d = j && j.data ? j.data : j;
    return (d && typeof d._rev === 'number') ? d._rev : 0;
  } catch (e) { return 0; }
}

function snapList() {
  try {
    return fs.readdirSync(AUTOSAVE_DIR)
      .filter(f => f.startsWith(SNAP_PREFIX) && f.endsWith('.json'))
      .sort();
  } catch (e) { return []; }
}

function writeAutosave(text) {
  let ok = false, snap = null;
  try {
    fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });
  } catch (e) { return false; }

  // ① 真正兜底的那一份：新文件名，不依赖覆盖能力
  try {
    const rev = String(snapRevOf(text)).padStart(9, '0');
    const name = SNAP_PREFIX + rev + '-' + Date.now() + '.json';
    fs.writeFileSync(path.join(AUTOSAVE_DIR, name), text, 'utf8');
    snap = name;
    ok = true;
  } catch (e) { trace('快照写入失败 ' + ((e && e.message) || e)); }

  // ② 给人看的那一份 + 按日备份（写不进去不影响上面的结果）
  try { fs.writeFileSync(AUTOSAVE_FILE, text, 'utf8'); } catch (e) {}
  try {
    const daily = path.join(AUTOSAVE_DIR, 'ORIGIN-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(daily)) fs.writeFileSync(daily, text, 'utf8');
  } catch (e) {}

  // ③ 轮转：快照留最近 N 份，按日备份留 30 份
  const all = snapList();
  while (all.length > SNAP_KEEP) {
    try { fs.unlinkSync(path.join(AUTOSAVE_DIR, all.shift())); } catch (e) { break; }
  }
  try {
    const olds = fs.readdirSync(AUTOSAVE_DIR)
      .filter(f => /^ORIGIN-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    while (olds.length > 30) {
      try { fs.unlinkSync(path.join(AUTOSAVE_DIR, olds.shift())); } catch (e) { break; }
    }
  } catch (e) {}

  return ok;
}

/* 最近一份快照。读不出来就返回 ok:false，让渲染层自己决定怎么办。 */
function latestSnapshot() {
  const all = snapList();
  for (let i = all.length - 1; i >= 0; i--) {
    const p = path.join(AUTOSAVE_DIR, all[i]);
    try {
      const text = fs.readFileSync(p, 'utf8');
      JSON.parse(text);                       // 半截文件直接跳过，往前找
      const st = fs.statSync(p);
      return { ok: true, text: text, name: all[i], path: p,
               at: st.mtime.toISOString(), rev: snapRevOf(text), count: all.length };
    } catch (e) { /* 继续往前找 */ }
  }
  return { ok: false, error: '还没有可用的快照', count: all.length };
}

function autosaveInfo() {
  const snap = latestSnapshot();
  let plain = null;
  try {
    const st = fs.statSync(AUTOSAVE_FILE);
    plain = { exists: true, at: st.mtime.toISOString(), size: st.size, path: AUTOSAVE_FILE };
  } catch (e) { plain = { exists: false, path: AUTOSAVE_FILE }; }
  // 以快照为准：它才是真正能跨进程活下来的那一份
  if (snap.ok) return Object.assign({}, plain, {
    exists: true, at: snap.at, size: snap.text.length, path: snap.path,
    snapshot: snap.name, snapRev: snap.rev, snapCount: snap.count
  });
  return Object.assign({}, plain, { snapCount: snap.count });
}

/* ---------- 窗口 ---------- */
let win = null;
const ICON = path.join(__dirname, 'icon.ico');
const INDEX = path.join(__dirname, 'renderer', 'index.html');

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 1040, minHeight: 640,
    title: APP_NAME,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0f1523',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  if (b.maximized) win.maximize();

  // 标题栏和任务栏统一显示短名字，别把网页里那句长标题顶上去
  win.on('page-title-updated', e => e.preventDefault());

  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });

  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== win.webContents.getURL().split('#')[0]) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (SMOKE) {
    win.webContents.on('console-message', (e, level, message, line, source) => {
      if (level >= 2) smokeLog.push('console[' + level + '] ' + message + ' @' + line);
    });
    win.webContents.on('render-process-gone', (e, d) => {
      smokeLog.push('render-process-gone: ' + JSON.stringify(d));
    });
  }

  // 先挂监听再加载，避免本地文件"太快加载完"把事件错过
  if (SMOKE) win.webContents.once('did-finish-load', () => setTimeout(runSmoke, 900));
  if (IMPORT) win.webContents.once('did-finish-load', () => setTimeout(runImport, 1200));
  if (KBSTAT) win.webContents.once('did-finish-load', () => setTimeout(runKbStat, 1500));
  if (KBRESTORE) win.webContents.once('did-finish-load', () => setTimeout(runKbRestore, 1500));

  win.loadFile(INDEX).then(() => trace('loadFile 已发起')).catch(e => trace('loadFile 失败 ' + e));
  win.webContents.on('did-finish-load', () => trace('did-finish-load 到了'));
  win.webContents.on('did-fail-load', (e, code, desc, url) =>
    trace('did-fail-load ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('render-process-gone', (e, d) => trace('render-process-gone ' + JSON.stringify(d)));
  return win;
}

/* ---------- 菜单 ---------- */
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMenu() {
  const mods = [
    ['today', '今日', '1'], ['calib', '校准', '2'], ['dec', '决策', '3'],
    ['seek', '追问', '4'], ['radar', '雷达', '5'], ['forge', '工坊', '6'],
    ['opp', '机会', '7'], ['eng', '英语', '8'], ['log', '日志', '9']
  ];
  const work = [['kb', '知识库']].concat(PURE ? [] : [['liuyi', '六艺']]).concat([['stats', '档案'], ['about', '关于']]);
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        // 下面这几条的快捷键由界面自己处理，这里只负责把提示写在右边（\t）。
        // 两边都注册会出现"按一次弹出两个保存框"，所以只留一边。
        { label: '导出备份到文件…\tCtrl+S', click: () => send('menu', 'backup') },
        { label: '从备份文件导入…\tCtrl+O', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'restore') },
        { type: 'separator' },
        { label: '立即自动备份到磁盘\tCtrl+Shift+S', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', 'autosave-now') },
        { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR) },
        { label: '打开知识库文件夹', click: () => { try { fs.mkdirSync(KB_DIR, { recursive: true }); } catch (e) {} shell.openPath(KB_DIR); } },
        { type: 'separator' },
        { label: '导出全部记录为 Markdown', click: () => send('menu', 'markdown') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '前往(&G)',
      submenu: mods.map(m => ({
        label: m[1] + (m[2] ? '\tAlt+' + m[2] : ''),
        click: () => send('nav', m[0])
      })).concat([
        { type: 'separator' }
      ]).concat(work.map(m => ({
        label: m[1],
        click: () => send('nav', m[0])
      }))).concat([
        { type: 'separator' },
        { label: '搜索全部内容…\tCtrl+K', click: () => send('menu', 'palette') }
      ])
    },
    {
      label: '模型(&M)',
      visible: !PURE,
      submenu: [
        { label: '模型设置…', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { label: '检查连接状态', click: () => send('menu', 'ai-ping') },
        { type: 'separator' },
        { label: '模型文件夹说明', click: () => dialog.showMessageBox(win, {
            type: 'info', title: '模型放在哪',
            message: '这个程序不捆绑模型。',
            detail: '六艺和知识库用的是你机器上已经装好的模型服务（默认地址 ' + aiCfg.endpoint + '）。\n\n' +
              '当前对话模型：' + aiCfg.chatModel + '\n当前嵌入模型：' + aiCfg.embedModel + '\n\n' +
              '换模型在「模型设置」里改，不用重新打包这个程序。'
          }) }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { role: 'reload', label: '重新载入', accelerator: 'F5' },
        { label: '强制重新载入', accelerator: 'CmdOrCtrl+F5', click: () => win && win.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏', accelerator: 'F11' },
        { role: 'toggleDevTools', label: '开发者工具', accelerator: 'F12' }
      ]
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '关于' + APP_NAME, click: () => send('nav', 'about') },
        { label: '在文件管理器中显示程序', click: () => shell.showItemInFolder(process.execPath) },
        { label: '数据文件夹位置', click: () => dialog.showMessageBox(win, {
            type: 'info', title: '数据存放在哪里', message: '你的记录保存在这个文件夹里：',
            detail: DATA_DIR + '\n\n把它复制走，就等于带走全部记录。'
          }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- AI 配置 ---------- */
const AI_DEFAULT = {
  endpoint: 'http://127.0.0.1:11434/v1',
  chatModel: 'qwen2.5:3b',
  embedModel: 'nomic-embed-text:latest',
  maxTokens: 2048,
  temperature: 0.5,
  thinking: true
};
let aiCfg = Object.assign({}, AI_DEFAULT, readJSON(AI_CFG_FILE, {}) || {});
function saveAiCfg() { writeJSON(AI_CFG_FILE, aiCfg); }

/* ---------- AI 代理 ----------
   渲染层其实也能直接 fetch 本地服务，但会撞两件事：
   1) file:// 页面发出的跨源请求，CORS 预检常常过不去；
   2) Chromium 会拦"加密页面请求明文 http"的混合内容。
   请求放在主进程发，这两个问题都不存在了。顺便也让"模型名/地址"只存一份。 */
function httpPost(url, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('接口地址不合法：' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname.replace(/\/+$/, '') || '') + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return reject(new Error('接口返回 ' + res.statusCode + '：' + text.slice(0, 200)));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('接口没有返回 JSON：' + text.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs || 600000, () => {
      req.destroy(new Error('超时（' + Math.round((timeoutMs || 600000) / 1000) + ' 秒）'));
    });
    req.on('error', e => {
      const m = String(e && e.message || e);
      if (/ECONNREFUSED/i.test(m)) {
        reject(new Error('连不上本地模型服务。请确认它已经启动，地址是 ' + aiCfg.endpoint));
      } else reject(new Error(m));
    });
    req.write(payload);
    req.end();
  });
}

/* 模型爱在回答里夹思考过程，这里统一剥掉 */
function stripThink(s) {
  return String(s || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

ipcMain.handle('ai:config', () => Object.assign({}, aiCfg));

ipcMain.handle('ai:setConfig', (e, patch) => {
  if (patch && typeof patch === 'object') {
    Object.keys(patch).forEach(k => {
      if (patch[k] !== undefined && patch[k] !== null) aiCfg[k] = patch[k];
    });
    if (aiCfg.maxTokens) aiCfg.maxTokens = parseInt(aiCfg.maxTokens, 10) || 2048;
    if (typeof aiCfg.temperature === 'string') aiCfg.temperature = parseFloat(aiCfg.temperature) || 0.5;
    saveAiCfg();
  }
  return Object.assign({}, aiCfg);
});

/* 探活：顺便把服务上挂着哪些模型报回来，用户不必自己去敲命令 */
ipcMain.handle('ai:ping', async () => {
  try {
    const r = await httpPost(simpleGetURL(aiCfg.endpoint, '/models'), {}, 8000)
      .catch(() => null);
    if (r && Array.isArray(r.data)) {
      return { ok: true, models: r.data.map(m => m.id).filter(Boolean) };
    }
    return { ok: true, models: [] };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* /models 是 GET，httpPost 只发 POST —— 单独开一条腿，免得把上面那个函数写得四不像 */
function simpleGetURL(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + suffix;
}
ipcMain.handle('ai:listModels', async () => {
  return new Promise(resolve => {
    let u;
    try { u = new URL(simpleGetURL(aiCfg.endpoint, '/models')); }
    catch (e) { return resolve({ ok: false, error: '接口地址不合法' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 8000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ ok: true, models: (j.data || []).map(m => m.id).filter(Boolean) });
        } catch (e) { resolve({ ok: false, error: '模型列表读取失败' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时' }); });
    req.on('error', e => resolve({ ok: false, error: String(e.message || e) }));
  });
});

/* 单轮问答。渲染层负责拼 messages（含知识库片段），主进程只负责发出去。 */
ipcMain.handle('ai:chat', async (e, messages, opts) => {
  const o = opts || {};
  const body = {
    model: o.model || aiCfg.chatModel,
    messages: messages,
    temperature: (typeof o.temperature === 'number') ? o.temperature : aiCfg.temperature,
    max_tokens: o.maxTokens || aiCfg.maxTokens,
    stream: false
  };
  try {
    const t0 = Date.now();
    const r = await httpPost(simpleGetURL(aiCfg.endpoint, '/chat/completions'), body, o.timeout || 600000);
    const msg = r && r.choices && r.choices[0] && r.choices[0].message;
    if (!msg) return { ok: false, error: '模型没有返回内容' };
    const usage = r.usage || {};
    return {
      ok: true,
      content: stripThink(msg.content),
      reasoning: stripThink(msg.reasoning_content || ''),
      ms: Date.now() - t0,
      tokens: usage.completion_tokens || 0
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 批量取向量。知识库上传时用，一次几十段——逐条发太慢。 */
ipcMain.handle('ai:embed', async (e, texts) => {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return { ok: true, vectors: [] };
  try {
    const r = await httpPost(simpleGetURL(aiCfg.endpoint, '/embeddings'),
      { model: aiCfg.embedModel, input: list }, 600000);
    const arr = (r && r.data) || [];
    const vectors = arr.map(x => x.embedding).filter(Boolean);
    if (vectors.length !== list.length) {
      return { ok: false, error: '嵌入数量对不上：要 ' + list.length + ' 条，回了 ' + vectors.length + ' 条' };
    }
    return { ok: true, vectors: vectors, model: aiCfg.embedModel };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* ---------- 知识库：文件落盘 ----------
   原文一直留在磁盘上（就是 .txt 本身），索引单独存一份 JSON。
   这样做的好处：即使索引算错了、模型换了，原文还在，重建一次就行。 */
function kbSafeName(name) {
  return String(name || 'untitled.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}
function kbEnsureDirs() {
  fs.mkdirSync(KB_FILES_DIR, { recursive: true });
  fs.mkdirSync(KB_INDEX_DIR, { recursive: true });
}

ipcMain.handle('kb:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要放进知识库的文本',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本文件', extensions: ['txt', 'md', 'markdown', 'csv', 'text'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const out = [];
  for (const p of r.filePaths) {
    try {
      const buf = fs.readFileSync(p);
      out.push({
        ok: true,
        name: path.basename(p),
        path: p,
        bytes: buf.length,
        text: decodeText(buf)
      });
    } catch (err) {
      out.push({ ok: false, name: path.basename(p), error: String(err.message || err) });
    }
  }
  return { ok: true, files: out };
});

/* Windows 上从别处拿来的 txt 大多不是 utf-8，直接按 utf-8 读会满屏乱码。
   按 BOM → utf-8 → gbk → latin1 的顺序试，第一个不抛错的就认。 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const sw = Buffer.from(buf.slice(2));
    sw.swap16();
    return sw.toString('utf16le');
  }
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  try { return new TextDecoder('gbk').decode(buf); } catch (e) {}
  try { return new TextDecoder('gb18030').decode(buf); } catch (e) {}
  return buf.toString('latin1');
}

/* 落盘是让"原文"有个稳定副本 —— 用户挑完文件后把原文件挪走/改名也不会断链 */
ipcMain.handle('kb:saveFile', (e, name, text) => {
  try {
    kbEnsureDirs();
    const safe = kbSafeName(name);
    let target = path.join(KB_FILES_DIR, safe), n = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(safe);
      target = path.join(KB_FILES_DIR, path.basename(safe, ext) + '-' + (++n) + ext);
    }
    fs.writeFileSync(target, text, 'utf8');
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('kb:writeIndex', (e, docId, json) => {
  try {
    kbEnsureDirs();
    fs.writeFileSync(path.join(KB_INDEX_DIR, kbSafeName(docId) + '.json'), json, 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('kb:readIndex', (e, docId) => {
  try {
    return { ok: true, text: fs.readFileSync(path.join(KB_INDEX_DIR, kbSafeName(docId) + '.json'), 'utf8') };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('kb:deleteIndex', (e, docId) => {
  try { fs.unlinkSync(path.join(KB_INDEX_DIR, kbSafeName(docId) + '.json')); } catch (err) {}
  return { ok: true };
});

ipcMain.handle('kb:openDir', () => { kbEnsureDirs(); return shell.openPath(KB_DIR); });

ipcMain.handle('kb:reveal', (e, p) => { if (p) { try { shell.showItemInFolder(p); } catch (err) {} } });

/* 重新读一份已经入库的原文 —— 换模型重建索引时要用 */
ipcMain.handle('kb:readText', (e, name) => {
  try {
    const p = path.join(KB_FILES_DIR, kbSafeName(name));
    return { ok: true, text: decodeText(fs.readFileSync(p)) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

/* 导入 .txt 到知识库：顺便让"复习资料"也能从外面直接拖进来 */
ipcMain.handle('app:importText', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择文本文件',
    properties: ['openFile'],
    filters: [{ name: '文本', extensions: ['txt', 'md', 'markdown'] }, { name: '全部文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const p = r.filePaths[0];
    return { ok: true, name: path.basename(p), path: p, text: decodeText(fs.readFileSync(p)) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

/* ---------- 原生能力 ---------- */
ipcMain.handle('app:info', () => Object.assign({
  version: VERSION,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  dataDir: DATA_DIR,
  portable: IS_PORTABLE_LAYOUT,
  autosave: autosaveInfo()
}, {}));

ipcMain.handle('app:saveBackup', async (e, text, name) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: path.join(app.getPath('documents'), name || ('政点-' + stamp() + '.json')),
    filters: [{ name: '政点备份文件', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, text, 'utf8'); return { ok: true, path: r.filePath }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('app:openBackup', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: '备份文件', extensions: ['json'] }, { name: '全部文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const p = r.filePaths[0];
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { ok: true, path: p, name: path.basename(p), size: Buffer.byteLength(text, 'utf8'), text };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('app:autosave', (e, text) => {
  state = writeAutosave(text);
  return { ok: state, at: new Date().toISOString(), path: AUTOSAVE_FILE };
});

ipcMain.on('app:autosave-sync', (e, text) => {
  if (typeof text === 'string' && text.length > 20) { state = writeAutosave(text); }
  e.returnValue = state;
});

/* 启动时把磁盘上最新那份状态要回来。
   浏览器存储被清理、或者是"写进去重启就没了"的盘，都靠这一步救回来。 */
ipcMain.handle('app:readSnapshot', () => latestSnapshot());

ipcMain.handle('app:readAutosave', () => {
  try { return { ok: true, text: fs.readFileSync(AUTOSAVE_FILE, 'utf8'), path: AUTOSAVE_FILE }; }
  catch (err) {
    const snap = latestSnapshot();            // 常规那份读不到就退回快照
    if (snap.ok) return { ok: true, text: snap.text, path: snap.path };
    return { ok: false, error: String(err.message || err) };
  }
});

/* 知识库：磁盘上有原文和索引，但记录清单（谁在库里）只存在状态里。
   状态一旦丢了，资料看着还在、库里却是空的。这个通道按索引文件把清单重建回来。 */
ipcMain.handle('kb:scanIndex', () => {
  const out = [];
  try {
    for (const f of fs.readdirSync(KB_INDEX_DIR)) {
      if (!/\.json$/i.test(f)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(KB_INDEX_DIR, f), 'utf8'));
        if (!d || !d.doc) continue;
        out.push({
          id: d.doc, name: d.name || f.replace(/\.json$/i, ''),
          at: d.at || '', embed: d.embed || '',
          chunks: Array.isArray(d.chunks) ? d.chunks.length : 0,
          bytes: Array.isArray(d.chunks)
            ? d.chunks.reduce((n, c) => n + String(c && c.text || '').length, 0) : 0
        });
      } catch (e) { /* 坏文件跳过 */ }
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true, list: out };
});

ipcMain.handle('app:openDataDir', () => shell.openPath(DATA_DIR));

/* 首次启动：看看这个文件夹里有没有现成的备份，可以直接导入。
   只认真正装着东西的备份 —— 空壳备份只会让人以为"数据还在"，反而添乱。 */
function countRecords(d) {
  if (!d || typeof d !== 'object') return 0;
  const len = x => Array.isArray(x) ? x.length : 0;
  const answered = Array.isArray(d.inquiry)
    ? d.inquiry.filter(x => x && x.a && String(x.a).trim()).length : 0;
  return len(d.calib && d.calib.log) + len(d.log) + len(d.forge) + len(d.opps) +
    len(d.decisions) + len(d.radar) + answered;
}

ipcMain.handle('app:scanBackups', () => {
  const dirs = [EXE_DIR, path.dirname(EXE_DIR), AUTOSAVE_DIR, app.getPath('downloads')];
  const seen = new Set();
  const out = [];
  dirs.forEach(d => {
    let list = [];
    try { list = fs.readdirSync(d); } catch (e) { return; }
    list.filter(f => /\.json$/i.test(f)).slice(0, 80).forEach(f => {
      const p = path.join(d, f);
      if (seen.has(p)) return;
      seen.add(p);
      try {
        const st = fs.statSync(p);
        if (st.size < 120 || st.size > 8e7) return;
        const text = fs.readFileSync(p, 'utf8');
        if (text.indexOf('ORIGIN-backup') < 0) return;
        let d2 = null;
        try { const j = JSON.parse(text); d2 = j && j.data ? j.data : j; } catch (e) { return; }
        const n = countRecords(d2);
        if (!n) return;
        out.push({ path: p, name: f, size: st.size, at: st.mtime.toISOString(), records: n });
      } catch (e) { /* 跳过读不了的文件 */ }
    });
  });
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, 8);
});

ipcMain.handle('app:importPath', (e, p) => {
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { ok: true, text, name: path.basename(p), size: Buffer.byteLength(text, 'utf8') };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('app:writeFile', async (e, text, name, ext) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出文件',
    defaultPath: path.join(app.getPath('documents'), name || ('政点-' + stamp() + '.md')),
    filters: [{ name: (ext || 'md').toUpperCase() + ' 文件', extensions: [ext || 'md'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, text, 'utf8'); return { ok: true, path: r.filePath }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('app:reveal', (e, p) => { if (p) shell.showItemInFolder(p); });

let state = false;

/* ---------- 冒烟测试 ---------- */
const smokeLog = [];
const SMOKE_REPORT = path.join(SHOTS_DIR, 'origin-smoke-report.json');

function smokeOut(payload) {
  // Windows 上 Electron 是 GUI 子系统程序，stdout 回不到终端 —— 所以报告落成文件
  try { fs.writeFileSync(SMOKE_REPORT, JSON.stringify(payload, null, 2), 'utf8'); } catch (e) {}
  try { process.stdout.write('\n__SMOKE_BEGIN__\n' + JSON.stringify(payload) + '\n__SMOKE_END__\n'); } catch (e) {}
  if (smokeLog.length) {
    try { process.stdout.write('__SMOKE_LOGS__\n' + smokeLog.join('\n') + '\n'); } catch (e) {}
  }
}

/* ═══════════ 体检（ORIGIN_KBSTAT=1）═══════════
   只读：把渲染进程里真实的状态摊开，写到 KBSTAT_OUT。
   数据和文件对不上时，先看这里，别靠猜。 */
function runKbStat() {
  (async () => {
    const out = { at: new Date().toISOString(), dataDir: DATA_DIR };
    try {
      out.state = JSON.parse(await win.webContents.executeJavaScript(
        'JSON.stringify({' +
        '  storageKeys:(function(){try{var a=[];for(var i=0;i<localStorage.length;i++)a.push(localStorage.key(i));return a}catch(e){return ["<读不了>"]}})(),' +
        '  storeChars:(function(){try{return (localStorage.getItem("origin.v1")||"").length}catch(e){return -1}})(),' +
        '  rev:(S&&S._rev)||0,' +
        '  docs:((S&&S.kb&&S.kb.docs)||[]).map(function(d){return {name:d.name,chunks:d.chunks,ready:!!d.ready,file:d.file}}),' +
        '  cards:((S&&S.kb&&S.kb.cards)||[]).length' +
        '})', true));
    } catch (e) { out.error = String((e && e.message) || e); }
    try {
      const files = fs.readdirSync(KB_FILES_DIR);
      const idx = fs.readdirSync(KB_INDEX_DIR);
      out.disk = { 原文: files.length, 索引: idx.length };
      out.autosave = autosaveInfo();
      out.snaps = snapList().slice(-3);
    } catch (e) { out.disk = { error: String((e && e.message) || e) }; }
    /* 顺手拍一张知识库页的照片。只切路由、只读，不动任何数据 ——
       截图模式（ORIGIN_SHOTS）会塞演示数据，不能拿真实资料跑。 */
    if (process.env.ORIGIN_KBSTAT_SHOT === '1') {
      try {
        await win.webContents.executeJavaScript(
          '(function(){try{' +
          'var o=document.getElementById("onb"); if(o) o.style.display="none";' +
          'var tt=document.getElementById("toasts"); if(tt) tt.style.display="none";' +
          'go("kb");}catch(e){}})()', true);
        await new Promise(r => setTimeout(r, 1300));
        const img = await win.webContents.capturePage();
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        out.shot = path.join(SHOTS_DIR, 'origin-kb-real.png');
        fs.writeFileSync(out.shot, img.toPNG());
      } catch (e) { out.shotError = String((e && e.message) || e); }
    }
    try { fs.writeFileSync(KBSTAT_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
    process.stdout.write('\n__KBSTAT__\n' + JSON.stringify(out) + '\n__KBSTAT_END__\n');
    app.exit(0);
  })();
}

/* ═══════════ 知识库清单重建（ORIGIN_KBRESTORE=1）═══════════
   磁盘上有 原文/ 和 索引/，但"库里有哪几份"记在状态里。
   状态一丢（浏览器存储被清、或盘不支持覆盖写），资料就成了没人认领的孤儿。
   这个模式按索引文件把清单重建出来 —— 向量本来就在索引里，不用重算。 */
function runKbRestore() {
  const LOGF = path.join(DATA_DIR, '重建日志.txt');
  const log = s => { try { fs.appendFileSync(LOGF, new Date().toTimeString().slice(0, 8) + '  ' + s + '\n'); } catch (e) {} };
  try { fs.unlinkSync(LOGF); } catch (e) {}

  (async () => {
    // ① 索引文件就是"库里有哪些资料"的最可靠来源
    let idx = [];
    try {
      for (const f of fs.readdirSync(KB_INDEX_DIR)) {
        if (!/\.json$/i.test(f)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(KB_INDEX_DIR, f), 'utf8'));
          if (d && d.doc) idx.push({
            id: d.doc, name: d.name || f.replace(/\.json$/i, ''),
            at: d.at || '', embed: d.embed || '',
            chunks: Array.isArray(d.chunks) ? d.chunks.length : 0
          });
        } catch (e) { log('索引读不了 ' + f); }
      }
    } catch (e) { log('索引目录打不开：' + ((e && e.message) || e)); }
    log('索引文件 ' + idx.length + ' 份');

    // ② 给每份资料找回落盘的原文。同名可能有多个（文件名冲突时会被加上 -2、-3），
    //    用写入时间跟索引里的时间对上，比按名字猜可靠。
    let files = [];
    try { files = fs.readdirSync(KB_FILES_DIR).filter(f => !f.endsWith('.tmp')); } catch (e) {}
    const stat = {};
    files.forEach(f => { try { stat[f] = fs.statSync(path.join(KB_FILES_DIR, f)); } catch (e) {} });
    const baseOf = n => n.replace(/-(\d+)(\.[^.]+)$/, '$2');

    const recs = idx.map(it => {
      const want = Date.parse(it.at) || 0;
      let best = null, bestGap = Infinity;
      files.forEach(f => {
        if (f !== it.name && baseOf(f) !== it.name) return;
        const m = stat[f] ? stat[f].mtimeMs : 0;
        const gap = want ? Math.abs(m - want) : (f === it.name ? 0 : 1);
        if (gap < bestGap) { bestGap = gap; best = f; }
      });
      const s = best ? stat[best] : null;
      return {
        id: it.id, name: it.name, at: (it.at || '').slice(0, 10) || todayStr(),
        bytes: s ? s.size : 0, chunks: it.chunks, ready: true, embed: it.embed,
        file: best || '', path: best ? path.join(KB_FILES_DIR, best) : '',
        rebuilt: true
      };
    });
    const noFile = recs.filter(r => !r.file);
    log('对上原文 ' + (recs.length - noFile.length) + ' 份' +
        (noFile.length ? '，' + noFile.length + ' 份没找到原文（' + noFile.slice(0, 3).map(r => r.name).join('、') + '）' : ''));

    // ③ 交给渲染层并进状态并落盘（走应用自己的 save，两条通道都会写）
    const install = fs.readFileSync(path.join(__dirname, 'import-kb.js'), 'utf8');
    await win.webContents.executeJavaScript(install, true);
    const r = JSON.parse(await win.webContents.executeJavaScript(
      'window.__kbAdopt(' + JSON.stringify(recs) + ')', true));
    log('结果：新增 ' + r.added + ' 份，已在库跳过 ' + r.skipped + ' 份，库里现有 ' + r.total + ' 份');

    let save = {};
    try { save = JSON.parse(await win.webContents.executeJavaScript('window.__kbImportStat()', true)); } catch (e) {}
    log('落盘检查：库内 ' + save.docs + ' 份，索引已建 ' + save.ready + ' 份');

    const out = process.env.ORIGIN_KBRESTORE_OUT;
    const text = JSON.stringify({ at: new Date().toISOString(), index: idx.length,
      matched: recs.length - noFile.length, added: r.added, skipped: r.skipped,
      total: r.total, stat: save, missing: noFile.map(x => x.name) }, null, 2);
    if (out) { try { fs.writeFileSync(out, text, 'utf8'); } catch (e) {} }
    process.stdout.write('\n__KBRESTORE__\n' + text + '\n__KBRESTORE_END__\n');
    await new Promise(r2 => setTimeout(r2, 2500));   // 留时间给磁盘快照
    app.exit(0);
  })().catch(e => { log('异常 ' + ((e && e.stack) || e)); app.exit(1); });
}

function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ═══════════ 批量导入（ORIGIN_IMPORT=1）═══════════
   主进程读磁盘（渲染进程碰不到文件系统），一份一份递给渲染进程，
   由应用自己的 kbIngest 入库。每份都写日志，跑完落一份 JSON 报告。
   单份失败不影响后面的 —— "一定要成功"指的是整批走完，不是每份都完美。 */
function runImport() {
  const LOGF = path.join(DATA_DIR, '导入日志.txt');
  const REPORT = path.join(DATA_DIR, '导入报告.json');
  const log = s => { try { fs.appendFileSync(LOGF, new Date().toTimeString().slice(0, 8) + '  ' + s + '\n'); } catch (e) {} };
  try { fs.unlinkSync(LOGF); } catch (e) {}
  trace('runImport 开始');

  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(IMPORT_MANIFEST, 'utf8')); }
  catch (e) { log('清单读不了：' + (e && e.message)); return void app.exit(1); }
  log('清单 ' + manifest.length + ' 份；数据目录 ' + DATA_DIR);

  const watchdog = setTimeout(() => { log('整体超时（90 分钟），先退出'); app.exit(1); }, 90 * 60 * 1000);

  (async () => {
    const install = fs.readFileSync(path.join(__dirname, 'import-kb.js'), 'utf8');
    await win.webContents.executeJavaScript(install, true);
    log('注入完成');

    // 从头来过：把上次留下的半成品记录和落盘文件一起清掉，避免堆出一地孤儿文件
    if (process.env.ORIGIN_IMPORT_RESET === '1') {
      const c = JSON.parse(await win.webContents.executeJavaScript('window.__kbReset()', true));
      let dropped = 0;
      for (const dir of [KB_FILES_DIR, KB_INDEX_DIR]) {
        try {
          for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); dropped++; } catch (e) {}
          }
        } catch (e) {}
      }
      log('已重置：清掉 ' + c.cleared + ' 条资料记录、' + dropped + ' 个落盘文件');
    }
    log('开始逐份入库');

    const results = [];
    for (let i = 0; i < manifest.length; i++) {
      const it = manifest[i];
      let r = { ok: false, error: '没走到' };
      try {
        const text = fs.readFileSync(it.file, 'utf8');
        const js = 'window.__kbImportOne(' + JSON.stringify(it.name) + ',' + JSON.stringify(text) + ')';
        r = JSON.parse(await win.webContents.executeJavaScript(js, true));
      } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      r.name = it.name; r.root = it.root; r.bytes = it.bytes;
      results.push(r);
      log('[' + (i + 1) + '/' + manifest.length + '] ' +
        (r.skip ? '跳过（已在库）'
          : r.ok ? ('入库 ' + r.chunks + ' 段' + (r.ready ? '，索引已建' : '，索引没建、原文已留'))
          : ('失败 ' + r.error)) + '　' + it.name);
    }

    const stat = JSON.parse(await win.webContents.executeJavaScript('window.__kbImportStat()', true));
    const okN = results.filter(x => x.ok && !x.skip).length;
    const skipN = results.filter(x => x.skip).length;
    const failN = results.filter(x => !x.ok).length;
    clearTimeout(watchdog);
    // 报告本身不值得让整批白干。有的盘不允许覆盖已有文件，
    // 那就换个带时间戳的新文件名写，照样留得下。
    const reportText = JSON.stringify({
      at: new Date().toISOString(), total: manifest.length,
      ok: okN, skip: skipN, fail: failN, stat: stat, results: results
    }, null, 1);
    try {
      fs.writeFileSync(REPORT, reportText, 'utf8');
    } catch (e) {
      const alt = REPORT.replace(/\.json$/i, '-' + Date.now().toString().slice(-6) + '.json');
      try { fs.writeFileSync(alt, reportText, 'utf8'); log('报告改写到 ' + path.basename(alt) + '（原文件名写不动）'); }
      catch (e2) { log('报告写不进去：' + ((e2 && e2.message) || e2)); }
    }
    log('结束：本次入库 ' + okN + ' 份，跳过 ' + skipN + ' 份，失败 ' + failN + ' 份。' +
        '库里现有 ' + stat.docs + ' 份资料（' + stat.ready + ' 份索引已建），' + stat.cards + ' 张复习卡。');
    await new Promise(r => setTimeout(r, 3000));   // 给 localStorage 和磁盘快照留点落盘时间
    app.exit(0);
  })().catch(e => { log('异常 ' + ((e && e.stack) || e)); app.exit(1); });
}

function runSmoke() {
  try { fs.unlinkSync(SMOKE_REPORT); } catch (e) {}
  trace('runSmoke 开始');
  const watchdog = setTimeout(() => {
    trace('看门狗超时');
    smokeOut({ fatal: '冒烟测试超时（90 秒没跑完）', consoleIssues: smokeLog.slice(0, 10) });
    app.exit(1);
  }, 90000);

  const finish = (report, failed) => {
    clearTimeout(watchdog);
    report.consoleIssues = smokeLog.slice(0, 10);
    smokeOut(report);
    app.exit(failed ? 1 : 0);
  };

  (async () => {
    const src = fs.readFileSync(path.join(__dirname, 'smoke.js'), 'utf8');
    let report = {};
    const res = await win.webContents.executeJavaScript(src, true);
    trace('冒烟脚本返回 ' + String(res).slice(0, 80));
    try { report = JSON.parse(res); }
    catch (e) { report = { fatal: '冒烟脚本没有返回 JSON: ' + String(res).slice(0, 300) }; }

    // 第二段：从主进程发一个"前往"事件，看菜单是不是真能驱动界面
    win.webContents.send('nav', 'dec');
    await new Promise(r => setTimeout(r, 500));
    report.navFromMenu = JSON.parse(await win.webContents.executeJavaScript(
      'JSON.stringify({' +
      '  topTitle:(document.querySelector("#topTitle")||{}).textContent||"",' +
      '  route:(typeof route!=="undefined")?route:"<无>",' +
      '  err:(document.querySelector("#view")||{}).innerHTML&&(document.querySelector("#view").innerHTML.indexOf("启动时出了一点问题")>=0)' +
      '})', true));

    // 第三段（可选）：让窗口给自己拍照，好让人真的看一眼渲染结果
    if (SHOTS) {
      const shots = [];
      try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch (e) {}
      const shoot = async (name) => {
        await new Promise(r => setTimeout(r, 420));
        trace('拍照 ' + name + ' 前');
        const img = await win.webContents.capturePage();
        const p = path.join(SHOTS_DIR, 'origin-ui-' + name + '.png');
        fs.writeFileSync(p, img.toPNG());
        shots.push(p);
        trace('拍照 ' + name + ' 后');
      };
      const run = async (name, script) => {
        await win.webContents.executeJavaScript(script, true);
        await shoot(name);
      };
      win.showInactive();
      if (MOBILE_SHOT){
        // 用真实的移动视口，而不是把窗口拉窄 —— 媒体查询看的才是对的东西
        win.setMinimumSize(180, 180);
        win.webContents.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: { width: SHOT_W, height: SHOT_H },
          viewSize: { width: SHOT_W, height: SHOT_H },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 2,
          scale: 1
        });
        win.setContentSize(SHOT_W, SHOT_H);
      } else {
        win.setSize(SHOT_W, SHOT_H);
      }
      await new Promise(r => setTimeout(r, 900));
      await shoot('00-onboarding');                 // 先拍首见面，再把它收起来
      await win.webContents.executeJavaScript(
        'var o=document.getElementById("onb"); if(o) o.style.display="none";' +
        'var t=document.getElementById("toasts"); if(t) t.style.display="none";', true);
      await run('01-today', 'go("today")');
      await run('02-calib', 'CAL.tab="quiz"; go("calib")');
      await run('03-dec', 'go("dec")');
      await run('04-stats', 'go("stats")');
      /* 雷达页要有点真实数据才拍得出样子。SMOKE 模式下数据目录是临时的，
         这里塞的演示数据不会落到任何真机上。 */
      await run('04b-radar', '(function(){' +
        'S.okr.cur={start:"2026-09-21",end:"2026-10-20",targets:{calib:60,decide:60,keep:60,eng:60,make:60,stay:60},createdAt:"2026-09-21"};' +
        'var rec=function(d,c,ok){return {id:"c"+d,sid:"b:"+d,date:d,ts:Date.parse(d),cat:"常识",stmt:"t",truth:true,verdict:ok?"true":"false",conf:c,correct:ok,brier:(c-(ok?1:0))*(c-(ok?1:0))}};' +
        'var ds=["2026-09-26","2026-09-27","2026-10-03"];S.calib.log=[];' +
        'for(var i=0;i<10;i++){S.calib.log.push(rec(ds[i%3],i<8?0.85:0.95,i!==4));}' +
        'S.eng=[{id:"e1",en:"kernel",zh:"内核",ease:2.5,iv:4,due:"2026-10-07",reps:3,lapses:0,born:"2026-09-01",last:"2026-09-26"},' +
        '{id:"e2",en:"latency",zh:"延迟",ease:2.4,iv:2,due:"2026-10-05",reps:2,lapses:0,born:"2026-09-01",last:"2026-09-27"}];' +
        'S.log=[{date:"2026-09-26",one:"a",learned:"b",next:"c"},{date:"2026-09-27",one:"a",learned:"b",next:"c"},{date:"2026-10-03",one:"a",learned:"b",next:"c"}];' +
        'S.days={"2026-09-26":{opens:2},"2026-09-27":{opens:1},"2026-10-03":{opens:4}};' +
        'S.radar=[{date:"2026-10-03",ts:Date.now(),scores:{prompt:8,agent:6,code:7,math:7,phys:6,eng:8}}];' +
        'go("radar");})()');
      await run('05-about', 'go("about")');
      await run('05b-about-app',
        'go("about"); (function(){var v=document.querySelector("#view");' +
        'v.style.scrollBehavior="auto";' +   // 界面默认是平滑滚动，截图会拍到一半
        'var jump=function(){v.scrollTop=v.scrollHeight;};' +
        'jump(); setTimeout(jump,150); setTimeout(jump,400);})()');
      await run('06-dark-today', 'toggleTheme(); go("today")');
      await run('07-dark-calibstats', 'CAL.tab="stats"; go("calib")');
      await run('08-palette', 'go("today"); openPalette(); (function(){var i=document.querySelector("#cmdInput"); if(i) i.value="校准"; i.dispatchEvent(new Event("input"));})()');
      // 命令面板是浮层，拍完要收起来，否则后面每一张都会被它盖住
      await win.webContents.executeJavaScript('closePalette();', true);
      // 新模块：六艺与知识库。先塞一点假数据，好让画面里有东西可看。
      await run('09-liuyi-data', 'toggleTheme(); (function(){' +
        'lyLoadCSV("姓名,语文,数学\\n张三,88,94\\n李四,79,85\\n王五,92,71","成绩.csv","");' +
        'LY.tab="data"; go("liuyi");})()');
      await run('10-liuyi-prompt', '(function(){LY.tab="prompt";' +
        'LY.prompt.out="# 角色\\n你是一位物理老师。\\n\\n## 背景\\n学生 15 岁，理性思维强。\\n\\n## 任务\\n把牛顿第二定律讲清楚。\\n\\n## 约束\\n不许用比喻，不许说\\"很简单\\"。\\n\\n## 输出格式\\n先给结论，再给三条例证。";' +
        'go("liuyi");})()');
      await run('11-liuyi-chat', '(function(){LY.tab="chat";' +
        'LY.chat.hist=[{role:"user",content:"为什么本地模型比在线模型慢这么多？"},' +
        '{role:"assistant",content:"因为它在你自己机器的 CPU 上跑，没有专门的加速硬件。\\n\\n在线服务的回答由成排的加速卡算出来，延迟主要是网络往返；而你这里每一层矩阵乘法都要在你的处理器上真算一遍。7B 模型每生成一个字要过 70 亿次参数，纯 CPU 大概一秒只能出 1 个字。\\n\\n换更小的模型，或者等哪天有显卡，速度会立刻不一样。"}];' +
        'go("liuyi");})()');
      await run('12-liuyi-table', 'LY.tab="table";' +
        'LY.table.csv="学号,姓名,语文,数学,英语\\n01,张三,88,94,76\\n02,李四,79,85,91\\n03,王五,92,71,68";go("liuyi")');
      await run('13-kb-docs', '(function(){' +
        'S.kb.docs=[{id:"d1",name:"物理·牛顿力学.txt",at:"2026-10-02",bytes:8240,chunks:26,ready:true,embed:"nomic-embed-text"},' +
        '{id:"d2",name:"英语·技术词汇.txt",at:"2026-10-02",bytes:4120,chunks:14,ready:true,embed:"nomic-embed-text"},' +
        '{id:"d3",name:"数学·数列与极限.txt",at:"2026-10-01",bytes:6300,chunks:19,ready:true,embed:"nomic-embed-text"}];' +
        'S.kb.cards=[' +
        '{id:"c1",docId:"d1",doc:"物理·牛顿力学.txt",q:"牛顿第二定律的表达式是什么？",a:"F = ma，即物体所受合外力等于质量乘以加速度。",fill:"物体所受合外力等于质量乘以",blank:"加速度",ease:2.5,iv:1,due:today(),reps:1,lapses:0,hist:[]},' +
        '{id:"c2",docId:"d1",doc:"物理·牛顿力学.txt",q:"为什么说惯性与速度无关？",a:"惯性只由质量决定。质量是物体保持原有运动状态的能力的度量，速度变快并不会让它更难改变运动状态，只是改变它需要的作用时间更短。",fill:"惯性大小只由",blank:"质量",ease:2.5,iv:0,due:today(),reps:0,lapses:0,hist:[]},' +
        '{id:"c3",docId:"d3",doc:"数学·数列与极限.txt",q:"巴塞尔问题的答案是什么？",a:"1+1/4+1/9+1/16+… = π²/6 ≈ 1.6449。分母是 n² 时收敛，换成 n 就发散。",fill:"",blank:"",ease:2.5,iv:0,due:today(),reps:0,lapses:0,hist:[]},' +
        '{id:"c4",docId:"d2",doc:"英语·技术词汇.txt",q:"concurrency 和 parallelism 的区别？",a:"concurrency 是同时处理多个任务的编排能力，parallelism 是真正在同一时刻执行。单核可以并发但不能并行。",fill:"单核可以",blank:"并发",ease:2.5,iv:0,due:today(),reps:0,lapses:0,hist:[]}];' +
        'KB.tab="docs";go("kb");})()');
      await run('14-kb-ask', '(function(){KB.tab="ask";KB.ask.q="加速度和质量什么关系";' +
        'KB.ask.hits=[{doc:"物理·牛顿力学.txt",i:3,score:0.87,kw:0.92,vec:0.79,text:"牛顿第二定律指出，物体加速度的大小跟作用力成正比，跟物体的质量成反比。写成等式就是 F = ma。\\n\\n这意味着：同样的力作用在质量更大的物体上，产生的加速度更小。这也解释了为什么推一辆空车比推一辆装满货的车轻松——不是力变小了，而是同样的力只能产生更小的加速度。"},' +
        '{doc:"物理·牛顿力学.txt",i:4,score:0.61,kw:0.55,vec:0.66,text:"惯性是物体保持原有运动状态的性质，其大小只由质量决定，与速度无关。"}];' +
        'KB.ask.answer="根据你的资料（第 1 段）：加速度跟作用力成正比，跟质量成反比，也就是 F = ma。\\n\\n所以质量越大，同样的力能产生的加速度就越小。（1）\\n\\n资料里还提到惯性的大小也只由质量决定，和速度无关。（2）\\n\\n你的资料里没有提到摩擦力的影响——如果算上摩擦，实际推车时的情况会更复杂一些。";' +
        'KB.ask.usedAI=true;KB.ask.note="在自己的资料里找到 2 段。";go("kb");})()');
      await run('15-kb-review', '(function(){KB.tab="review";KB.review.queue=["c2"];KB.review.idx=0;' +
        'KB.review.revealed=false;KB.review.verdict=null;KB.review.mode="qa";' +
        'KB.review.answer="因为惯性只跟质量有关，速度大了只是动量大了，要改变它需要的冲量更大，但这不是因为惯性变大了。";' +
        'finishJudge(S.kb.cards.find(c=>c.id==="c2"),{level:"hard",correct:true,conf:72,comment:"方向对了，但你把它和动量混在一起说了。惯性只看质量，动量才看速度。",label:"部分掌握"});' +
        'go("kb");})()');
      await run('16-kb-stats', '(function(){S.kb.brier=[' +
        '{date:today(),conf:92,correct:true,doc:"物理·牛顿力学.txt"},{date:today(),conf:88,correct:true,doc:"物理·牛顿力学.txt"},' +
        '{date:today(),conf:85,correct:false,doc:"数学·数列与极限.txt"},{date:today(),conf:78,correct:true,doc:"英语·技术词汇.txt"},' +
        '{date:today(),conf:75,correct:true,doc:"物理·牛顿力学.txt"},{date:today(),conf:70,correct:false,doc:"数学·数列与极限.txt"},' +
        '{date:today(),conf:65,correct:true,doc:"英语·技术词汇.txt"},{date:today(),conf:55,correct:false,doc:"数学·数列与极限.txt"},' +
        '{date:today(),conf:52,correct:true,doc:"英语·技术词汇.txt"},{date:today(),conf:45,correct:false,doc:"数学·数列与极限.txt"},' +
        '{date:today(),conf:35,correct:true,doc:"英语·技术词汇.txt"},{date:today(),conf:32,correct:false,doc:"物理·牛顿力学.txt"},' +
        '{date:today(),conf:25,correct:true,doc:"英语·技术词汇.txt"},{date:today(),conf:18,correct:false,doc:"数学·数列与极限.txt"}];' +
        'KB.tab="stats";go("kb");})()');
      // 设置窗口的模型列表是异步拉的，要等它出来再拍；滚动容器是 .modal 本身
      await run('17-settings',
        '(async function(){ try { toggleTheme(); lySettings();' +
        '  var t0 = Date.now();' +
        '  while (Date.now() - t0 < 6000){' +
        '    var box = document.querySelector("#lySetModels");' +
        '    if (box && box.children.length) break;' +
        '    await new Promise(function(r){ setTimeout(r, 120); });' +
        '  }' +
        '  var b = document.querySelector(".modal"); if (b) b.scrollTop = b.scrollHeight;' +
        '  await new Promise(function(r){ setTimeout(r, 280); });' +
        ' } catch (e) {} })()');
      await run('18-dark-liuyi', '(function(){closeModal();toggleTheme();LY.tab="data";go("liuyi");})()');

      /* 手机版专属：底部导航、抽屉、窄屏下的知识库与复习 ——
         这几张是判断"单手能不能真用"的依据，桌面尺寸看不出来。 */
      if (MOBILE_SHOT){
        await run('19-m-liuyi', 'LY.tab="data"; go("liuyi")');
        await run('20-m-kb', 'toggleTheme(); KB.tab="docs"; go("kb")');
        await run('21-m-review', 'KB.tab="review"; go("kb")');
        // 基准图：同一页、同一主题，只是不拉抽屉 —— 好和下面那张逐像素比。
        // 特意切回浅色主题：深色下遮罩和背景本来就接近，看不出差别。
        await run('21b-m-today', 'toggleTheme(); go("today")');
        await run('22-m-drawer', 'document.body.classList.add("nav-open")');
        await win.webContents.executeJavaScript('if (typeof navClose === "function") navClose();', true);
      }
      report.shots = shots;
    }

    const failed = !!report.fatal ||
      (report.fail && report.fail.length > 0) ||
      report.navFromMenu.route !== 'dec';
    finish(report, failed);
  })().catch(err => {
    finish({ fatal: String(err && err.stack || err) }, true);
  });
}

/* ---------- 启动 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    trace('whenReady');
    if (process.platform === 'win32') app.setAppUserModelId('com.origin.desktop');
    buildMenu();
    createWindow();
    trace('窗口已创建，SMOKE=' + SMOKE);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
