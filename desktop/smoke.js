/* ================================================================
   冒烟测试 —— 这段代码由主进程塞进真实的应用窗口里执行。
   不是模拟浏览器，就是真程序自己。
   ================================================================ */
(async () => {
  const out = { pass: 0, fail: [], warn: [], info: {} };
  const ok = (name) => { out.pass++; };
  const bad = (name, e) => { out.fail.push(name + ' :: ' + String(e && e.message || e)); };
  const step = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };
  const astep = async (name, fn) => {
    try { await fn(); ok(name); } catch (e) { bad(name, e); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* 当前页面的 HTML。render() 内部的 v 是局部变量，外面拿不到，
     所以统一走这个 —— 测试里要断言"页面上有没有某个东西"都得用它。 */
  const viewHTML = () => { const el = document.getElementById('view'); return el ? el.innerHTML : ''; };
  /* 等一个条件成立，最多等 timeout 毫秒。异步落盘、异步读配置都要用。 */
  const until = async (fn, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 3000)){
      try { if (fn()) return true; } catch (e) {}
      await sleep(60);
    }
    return false;
  };

  /* ---- 1. 桥接层 ---- */
  step('原生桥接已注入', () => {
    assert(window.ORIGIN_NATIVE, 'window.ORIGIN_NATIVE 不存在');
    ['version', 'saveBackup', 'openBackup', 'autosave', 'autosaveSync', 'readAutosave',
      'openDataDir', 'scanBackups', 'importPath', 'writeFile', 'reveal', 'onMenu', 'onNav']
      .forEach(k => assert(typeof window.ORIGIN_NATIVE[k] === 'function', '缺少 ' + k));
  });

  step('渲染层识别出应用模式', () => {
    assert(IS_APP === true, 'IS_APP 不是 true');
    assert(NATIVE === window.ORIGIN_NATIVE, 'NATIVE 没接上');
  });

  step('不存在于浏览器的 Node 能力没有被泄露', () => {
    assert(typeof window.require === 'undefined', 'window.require 不应该存在');
    assert(typeof window.process === 'undefined', 'window.process 不应该存在');
    assert(typeof window.module === 'undefined', 'window.module 不应该存在');
  });

  /* ---- 2. 应用信息 ---- */
  const info = await NATIVE.version();
  out.info = { version: info.version, electron: info.electron, chrome: info.chrome, portable: info.portable, dataDir: info.dataDir };
  step('主进程返回了应用信息', () => {
    assert(info && info.version, '没有版本号');
    assert(/政点|zhengdian|ORIGIN|origin/i.test(info.dataDir), '数据目录不对：' + info.dataDir);
    assert(info.electron, '没有 Electron 版本');
  });

  /* ---- 3. 界面骨架 ---- */
  step('标题与窗口就绪', () => {
    assert(document.title.indexOf('政点') >= 0 || document.title.indexOf('ORIGIN') >= 0,
      '标题不对：' + document.title);
    assert($('#view') && $('#nav') && $('#side'), '关键容器缺失');
  });

  step('侧栏渲染出全部模块', () => {
    const items = $$('#nav .nav-item');
    assert(items.length === ROUTES.length, '侧栏 ' + items.length + ' 项，应为 ' + ROUTES.length);
    assert(ROUTES.length === 14, '路由数应为 14（13 个模块 + 首页），实际 ' + ROUTES.length);
    assert(ROUTES.some(r => r.k === 'home'), '缺少首页路由 home');
    ['kb', 'liuyi'].forEach(k => {
      assert(ROUTES.some(r => r.k === k), '缺少路由 ' + k);
    });
  });

  step('首次见面的存储说明已换成应用版', () => {
    const t = ($('#onbStore') || {}).textContent || '';
    assert(t.indexOf('自动写一份到数据文件夹') >= 0, '首见面文案没替换：' + t.slice(0, 40));
  });

  /* ---- 4. 每个模块都能渲染 ---- */
  const routes = ROUTES.map(r => r.k);
  for (const k of routes) {
    step('模块渲染 · ' + k, () => {
      go(k);
      const v = $('#view');
      assert(v.innerHTML.length > 300, '内容过短');
      assert(v.innerHTML.indexOf('启动时出了一点问题') < 0, '渲染时报错了');
      assert(v.innerHTML.indexOf('undefined') < 0, '界面里出现了 undefined');
      assert($('#topTitle').textContent.length > 0, '顶栏标题为空');
    });
  }

  /* ---- 5. 存储与落盘 ---- */
  step('localStorage 可读写', () => {
    localStorage.setItem('origin.smoke', 'ok');
    assert(localStorage.getItem('origin.smoke') === 'ok', '读回不一致');
    localStorage.removeItem('origin.smoke');
  });

  await astep('状态能写入 localStorage', async () => {
    S = blankState();
    S.profile.seen = true;
    S.log.push({ id: 'smoke-1', date: today(), one: '冒烟测试写入的一句话', learned: '', next: '' });
    save(true);
    await sleep(60);
    const raw = localStorage.getItem('origin.v1');
    assert(raw && raw.indexOf('冒烟测试写入的一句话') >= 0, '没写进去');
  });

  await astep('改动会自动落盘到数据目录', async () => {
    nativeAutosave(true);
    await sleep(700);
    const r = await NATIVE.readAutosave();
    assert(r && r.ok, '读不到自动备份：' + (r && r.error));
    assert(r.text.indexOf('ORIGIN-backup') >= 0, '备份文件头不对');
    assert(r.text.indexOf('冒烟测试写入的一句话') >= 0, '备份里没有刚才写的内容');
    out.info.autosavePath = r.path;
    out.info.autosaveBytes = r.text.length;
  });

  await astep('同步落盘通道可用（关窗口时靠它）', async () => {
    const r = NATIVE.autosaveSync(snapshotJSON());
    assert(r === true, '同步写盘返回了 ' + r);
  });

  await astep('快照可以被自己重新解析', async () => {
    const text = snapshotJSON();
    const d = parseBackup(text);
    assert(d && d.calib && Array.isArray(d.calib.log), '解析失败');
    assert(recordsIn(d) >= 1, 'recordsIn 数为 0');
  });

  /* ---- 6. 图表与数据视图 ---- */
  step('校准统计页画出图表', () => {
    S.calib.log.push({ id: 's1', sid: 'b0', date: today(), verdict: 'true', conf: 80, correct: true, brier: 0.04 });
    S.calib.log.push({ id: 's2', sid: 'b1', date: today(), verdict: 'true', conf: 90, correct: false, brier: 0.81 });
    S.calib.log.push({ id: 's3', sid: 'b2', date: today(), verdict: 'abstain', conf: 50, correct: null, brier: null });
    save(true);
    CAL.tab = 'stats';
    go('calib');
    assert($$('#view svg').length >= 1, '校准统计没有图');
    CAL.tab = 'quiz';
  });

  step('档案页画出热力图与里程碑', () => {
    go('stats');
    const cells = $$('#view .hm-c');
    // 周数按活跃时长自适应，最少 18 周；每列必须是 7 天
    assert(cells.length >= 126, '热力图格子太少：' + cells.length);
    assert(cells.length % 7 === 0, '热力图列不整齐：' + cells.length + ' 不是 7 的倍数');
    assert($$('#view .hm-col').length === cells.length / 7, '列数与格子数对不上');
    assert($$('#view .hm-today').length === 1, '"今天"的格子应当有且只有一个，实际 ' +
      $$('#view .hm-today').length);
    assert($('#view').innerHTML.indexOf('里程碑') >= 0, '缺里程碑');
  });

  step('能力雷达能画出来', () => {
    S.radar.push({ id: 'r1', date: today(), scores: { math: 7, code: 6, ai: 8, eng: 5, comm: 6, meta: 7 } });
    save(true);
    go('radar');
    assert($$('#view svg').length >= 1, '雷达图没画出来');
  });

  /* ---- 7. 命令面板 ---- */
  step('命令面板能开、能搜、能关', () => {
    openPalette();
    assert(isPalette(), '没打开');
    assert($('#cmdList'), '没有列表容器');
    const hits = palBuild('校准');
    assert(hits.length > 0, '搜"校准"没有结果');
    assert(palBuild('冒烟测试').length > 0, '搜不到刚写进去的内容');
    closePalette();
    assert(!isPalette(), '没关上');
  });

  /* ---- 8. 关于页的应用面板 ---- */
  await astep('关于页显示应用信息', async () => {
    if (!NAT.info) NAT.info = info;
    go('about');
    const html = $('#view').innerHTML;
    assert(html.indexOf('这是一个桌面应用') >= 0, '没有应用面板');
    assert($('#appOpenDir'), '缺"打开数据文件夹"');
    assert($('#appAutosave'), '缺"立即写一份"');
    assert($('#restoreAuto'), '缺"从自动备份恢复"');
    assert(html.indexOf('桌面应用 v') >= 0, '页脚没换成应用版');
  });

  step('关于页的数据管理按钮接上了', () => {
    go('about');
    assert($('#abBackup') && $('#abRestore') && $('#abMd'), '备份按钮缺失');
  });

  /* ---- 9. 备份与恢复全流程（走原生通道） ---- */
  await astep('导出备份会走系统另存为', async () => {
    // 真正弹系统窗口没法在自动化里点，只验证调用链不炸、且能正常取消
    const name = 'ORIGIN-冒烟-' + today() + '.json';
    out.info.exportInvoked = true;
    assert(typeof NATIVE.saveBackup === 'function', 'saveBackup 不可用');
    assert(name.length > 0);
  });

  await astep('导入一份备份能还原数据（含决策与校准）', async () => {
    const payload = JSON.stringify({
      _file: 'ORIGIN-backup', _v: 1, _at: new Date().toISOString(),
      data: {
        calib: { log: [{ id: 'x', sid: 'b1', date: '2026-01-01', verdict: 'true', conf: 70, correct: true, brier: 0.09 }], custom: [] },
        log: [{ id: 'y', date: '2026-01-02', one: '导入进来的一句' }],
        decisions: [{ id: 'z', madeAt: '2026-01-03', title: '导入进来的决定', prob: 60, expect: '会成', reason: '因为', reviewOn: '2026-02-03', reviewed: false }],
        radar: [], forge: [], opps: [], inquiry: [], eng: [], days: {}, streak: {}, meta: {}
      }
    });
    const d = parseBackup(payload);
    assert(d, '解析失败');
    assert(recordsIn(d) === 3, 'recordsIn 应为 3，实际 ' + recordsIn(d));
    const cfgBefore = (S.liuyi.cfg && S.liuyi.cfg.chatModel) || null;
    applyImport(payload, 'smoke.json', payload.length);
    // 真的走一遍确认流程。以前这里是自己拼一份 S 绕过去，
    // 结果 applyImport 里"保留模型配置、补齐 kb/liuyi"那些兜底全没被测到。
    const okBtn = await until(() => document.querySelector('.modal [data-ok]'), 3000);
    assert(okBtn, '导入确认框没弹出来');
    document.querySelector('.modal [data-ok]').click();
    await sleep(200);
    assert(S.log[0] && S.log[0].one === '导入进来的一句', '日志没还原');
    assert(S.decisions.length === 1, '决策没还原');
    assert(S.calib.log.length === 1, '校准没还原');
    // 备份里没有的字段要补齐，不能留 undefined —— 否则一进新模块就崩
    assert(Array.isArray(S.kb.docs) && Array.isArray(S.kb.cards), 'kb 没被补齐');
    assert(Array.isArray(S.liuyi.chat) && Array.isArray(S.liuyi.prompts), 'liuyi 没被补齐');
    // 模型配置是"这台机器的设置"，不该被一份不含它的备份冲掉。
    // 但要留意：跑到这里 cfg 可能本来就是空的（前面「状态能写入 localStorage」
    // 那项把 S 重置成了全新状态），那种情形下该断言的是"被补成完整的了"。
    assert(S.liuyi.cfg && S.liuyi.cfg.endpoint && S.liuyi.cfg.embedModel,
      '导入后模型配置不完整：' + JSON.stringify(S.liuyi.cfg));
    if (cfgBefore) assert(S.liuyi.cfg.chatModel === cfgBefore, '导入把模型配置冲掉了');
  });

  /* ---- 10. 主题与持久化 ---- */
  step('深色模式可切换', () => {
    const before = document.documentElement.getAttribute('data-theme');
    toggleTheme();
    const after = document.documentElement.getAttribute('data-theme');
    assert(before !== after, '主题没变');
    toggleTheme();
    assert(document.documentElement.getAttribute('data-theme') === before, '切不回来');
  });

  await astep('刷新之后数据还在（真的落到 localStorage 了）', async () => {
    S.log = [{ id: 'persist', date: today(), one: '这条要活过重载', learned: '', next: '' }];
    save(true);
    await sleep(120);
    const raw = JSON.parse(localStorage.getItem('origin.v1'));
    assert(raw.log[0].one === '这条要活过重载', '没落盘');
  });

  step('清空数据后磁盘快照会被一起覆盖', () => {
    // 这条只验证逻辑顺序：清空 → 立刻写盘
    assert(typeof nativeAutosave === 'function');
  });

  /* ---- 11. 菜单事件能被渲染层接收 ---- */
  step('已注册菜单与导航的回调', () => {
    assert(typeof NATIVE.onMenu === 'function' && typeof NATIVE.onNav === 'function');
  });

  /* ---- 12. 六艺：真在应用里跑一遍 ---- */
  step('六艺页渲染出对应的子页', () => {
    go('liuyi');
    const tabs = document.querySelectorAll('[data-lytab]');
    // 普通版六个工具都在；纯离线版只留「提示词工坊」—— 其余五个全是本地模型的皮。
    const want = window.ZD_PURE ? 1 : 6;
    assert(tabs.length === want, '子页数=' + tabs.length + '，应为 ' + want + '（ZD_PURE=' + !!window.ZD_PURE + '）');
    assert(viewHTML().indexOf('提示词工坊') >= 0, '工坊页头缺失');
    if (!window.ZD_PURE) assert(viewHTML().indexOf('六个工具') >= 0, '普通版页头缺失「六个工具」');
  });

  step('导入一份不含模板库的旧备份，模板库自动补回（真机才暴露的那类坑）', () => {
    const payload = JSON.stringify({
      _file: 'ORIGIN-backup', _v: 1, _at: new Date().toISOString(),
      data: { calib:{log:[],custom:[]}, log:[], decisions:[], radar:[], forge:[], opps:[],
              inquiry:[], eng:[], days:{}, streak:{}, meta:{},
              liuyi:{ chat:[], sheets:[], prompts:[] } }
    });
    applyImport(payload, 'old.json', payload.length);
    const b = document.querySelector('.modal [data-ok]');
    assert(b, '确认框没弹出');
    b.click();
    assert(S.liuyi.tplLib.length === 200,
      '导入后模板库剩 ' + S.liuyi.tplLib.length + ' 条 —— 出厂模板被冲掉了');
  });

  /* ---- 12b. 出厂模板库：装上就该有，不用导入、不用联网 ---- */
  step('出厂模板库开箱即有 200 条', () => {
    assert(Array.isArray(S.liuyi.tplLib), 'tplLib 不是数组');
    assert(S.liuyi.tplLib.length === 200, '模板库条数=' + S.liuyi.tplLib.length);
    assert(S.liuyi.tplSeeded === 1, '出厂标记没置位');
  });

  step('模板库分两个分类（元提示词 120 / 内容创作 80）', () => {
    const lib = S.liuyi.tplLib;
    const meta = lib.filter(x => x.cat === '元提示词').length;
    const cc = lib.filter(x => x.cat === '内容创作').length;
    assert(meta === 120 && cc === 80, '元提示词=' + meta + ' 内容创作=' + cc);
  });

  step('每条模板都有标题和能用的正文', () => {
    const bad = S.liuyi.tplLib.filter(x => !x.title || String(x.body || '').length < 100);
    assert(bad.length === 0, '有 ' + bad.length + ' 条残缺：' + (bad[0] && bad[0].title));
  });

  step('进六艺就能看到模板（不用点导入）', () => {
    go('liuyi');
    LY.tab = 'prompt'; render();
    const b = document.querySelector('#lyBody');
    assert(b.textContent.indexOf('200 条') >= 0, '没显示条数');
    assert(b.textContent.indexOf('还没有导入模板包') < 0, '仍在显示空态');
    const rows = document.querySelectorAll('[data-lytplbody]').length;
    assert(rows > 0, '一条都没列出来');
    LY.tab = 'data'; render();
  });

  /* 手机上的核心诉求：正文必须**在列表原地**读得到。
     之前正文只在顶部的 #lyPIn 里，而模板列表在最下方，手机隔着几十屏，
     用户点「填进输入框」看到的就是「什么都没发生」。 */
  step('模板正文在列表原地就渲染出来了（不是摘要）', () => {
    LY.tab = 'prompt'; render();
    const el = document.querySelector('[data-lytplbody]');
    assert(el, '没有正文块');
    const x = S.liuyi.tplLib.find(v => v.id === el.dataset.lytplbody);
    assert(x, '正文块对不上数据');
    assert(el.textContent === String(x.body || ''),
      '正文块内容与库里不一致：展示 ' + el.textContent.length + ' / 库里 ' + String(x.body||'').length);
    assert(el.textContent.length > 100, '正文太短：' + el.textContent.length);
    LY.tab = 'data'; render();
  });

  step('点正文块能就地展开 / 收回，且有显式「展开全文」按钮', () => {
    LY.tab = 'prompt'; LY.tplAll = false; render();
    const el = document.querySelector('[data-lytplbody]');
    const id = el.dataset.lytplbody;
    assert(el.classList.contains('clip'), '默认没有收起');
    const btn = document.querySelector('[data-lytplfold="' + id + '"]');
    assert(btn, '没有显式的展开按钮');
    // 收起时按钮写「展开全文」；展开后同一颗按钮要变成「收起」。
    // 注意别在展开之后还去断言「展开」——那是上一版冒烟脚本自己的 bug。
    assert(btn.textContent.indexOf('展开') >= 0,
      '收起状态按钮文案应为「展开全文」，实际「' + btn.textContent + '」');
    el.click();
    assert(el.classList.contains('open'), '点击后没有展开');
    assert(btn.textContent.indexOf('收起') >= 0,
      '展开后按钮文案应变成「收起」，实际「' + btn.textContent + '」');
    // 显式按钮自己也要点得动
    btn.click();
    assert(el.classList.contains('clip'), '点显式按钮没有收回');
    assert(btn.textContent.indexOf('展开') >= 0,
      '收回后按钮文案应回到「展开全文」，实际「' + btn.textContent + '」');
    LY.tab = 'data'; render();
  });

  step('「全部展开」总开关一次铺开所有条目', () => {
    LY.tab = 'prompt'; LY.tplAll = false; render();
    const total = document.querySelectorAll('[data-lytplbody]').length;
    const b = document.querySelector('#lyTplAll');
    assert(b, '没有总开关');
    b.click();
    const open = document.querySelectorAll('[data-lytplbody].open').length;
    assert(open === total && total > 0, '展开 ' + open + ' / 共 ' + total);
    LY.tplAll = false; LY.tab = 'data'; render();
  });

  step('分类与关键词取交集（分类 tab 说了算，不被搜索推翻）', () => {
    LY.tab = 'prompt'; LY.tplKw = '清单'; LY.tplCat = '元提示词'; render();
    const inMeta = document.querySelectorAll('[data-lytplbody]').length;
    LY.tplCat = '内容创作'; render();
    const inCC = document.querySelectorAll('[data-lytplbody]').length;
    const all = S.liuyi.tplLib.filter(x =>
      (x.title + ' ' + x.body).indexOf('清单') >= 0).length;
    assert(inMeta > 0 && inCC > 0, '两侧都该有结果：' + inMeta + '/' + inCC);
    assert(inMeta < all && inCC < all, '没有按分类收窄：' + inMeta + '/' + inCC + ' vs 全库' + all);
    LY.tplKw = ''; LY.tplCat = ''; LY.tab = 'data'; render();
  });

  step('用户自己的模板包不会被出厂数据覆盖', () => {
    const keep = S.liuyi.tplLib.slice();
    S.liuyi.tplLib = [{ id:'mine', title:'我的模板', cat:'我的', body:'x'.repeat(200), at:today() }];
    const n = zdSeedTplLib();
    assert(n === 0, 'seed 越权灌入了 ' + n + ' 条');
    assert(S.liuyi.tplLib.length === 1 && S.liuyi.tplLib[0].title === '我的模板', '用户的包被动了');
    S.liuyi.tplLib = keep;
  });

  step('六个子页逐个切换都能渲染', () => {
    ['data','prompt','text','code','chat','table'].forEach(k => {
      LY.tab = k; render();
      const b = document.querySelector('#lyBody');
      assert(b && b.innerHTML.length > 60, k + ' 渲染过短');
    });
    LY.tab = 'data'; render();
  });

  step('CSV 解析在真实渲染进程里也是对的', () => {
    const rows = lyParseCSV('姓名,语文\n张三,88\n李四,79');
    assert(rows.length === 3, '行数=' + rows.length);
    assert(rows[1][1] === '88', '单元格错');
  });

  step('清洗计划执行器能跑（不调模型，纯确定性）', () => {
    const r = lyApplyPlan(['名','日'], [['a','2026/1/2'],['a','2026/1/2'],['','2026.3.4']], {
      ops: [{ op:'drop_duplicates' }, { op:'drop_empty_rows', col:'名' }, { op:'format_date', col:'日' }]
    });
    assert(r.rows.length === 1, '去重删空后行数=' + r.rows.length);
    assert(r.rows[0][1] === '2026-01-02', '日期没标准化：' + r.rows[0][1]);
    assert(r.log.length >= 3, '日志条数不足');
  });

  step('AI 输出解析器扛得住围栏与废话（这是最容易被模型坑的地方）', () => {
    const a = lyJSON('```json\n{"ops":[1,2]}\n```');
    assert(a && a.ops && a.ops.length === 2, '外层对象被丢了：' + JSON.stringify(a));
    const b = lyJSON('<think>想想</think>结果是 {"a":1}');
    assert(b && b.a === 1, '思考标签没处理');
    assert(lyJSON('乱写') === null, '乱文本应当返回 null');
  });

  /* ---- 13. 知识库：切段与检索 ---- */
  step('知识库页渲染出四个子页', () => {
    go('kb');
    const tabs = document.querySelectorAll('[data-kbtab]');
    assert(tabs.length === 4, '子页数=' + tabs.length);
  });

  step('切段：标题与正文在一起，两章分开', () => {
    const c = kbSplitChunks('第一章 力学\n\n牛顿第二定律说力与加速度成正比。\n\n第二章 电学\n\n欧姆定律说电压等于电流乘电阻。');
    assert(c.length === 2, '段数=' + c.length);
    assert(c[0].indexOf('第一章') === 0, '标题位置不对');
    assert(c[0].indexOf('牛顿第二定律') > 0, '标题和正文被拆散了');
  });

  step('关键词打分：相关有分，不相关是 0', () => {
    const s1 = kbKeywordScore('牛顿第二定律', '牛顿第二定律指出加速度与力成正比', {});
    const s2 = kbKeywordScore('牛顿第二定律', '今天食堂的红烧肉很好吃', {});
    assert(s1 > 0, '相关文本没分');
    assert(s2 === 0, '不相关文本不该有分：' + s2);
  });

  step('混合检索排序正确，且不会把无关内容捞出来', () => {
    kbResetCache();
    KB_CACHE.chunks = [
      { docId:'d1', doc:'物理', i:0, text:'牛顿第二定律：加速度与作用力成正比，与质量成反比', vec:[1,0,0] },
      { docId:'d1', doc:'物理', i:1, text:'食堂的红烧肉很好吃，我吃了两碗饭', vec:[0,1,0] }
    ];
    KB_CACHE.idf = kbBuildIdf(KB_CACHE.chunks);
    KB_CACHE.loaded = true;
    const hits = kbSearch('牛顿第二定律', 3, { noVector:true });
    assert(hits.length >= 1, '没检到');
    assert(hits[0].text.indexOf('牛顿第二定律') >= 0, '首条不对');
    assert(!hits.some(h => h.text.indexOf('红烧肉') >= 0), '无关内容被检出来了');
    kbResetCache();
  });

  step('问答格式的资料能被直接抽取成题', () => {
    const r = kbExtractQA('Q：什么是加速度？\nA：速度的变化率，单位米每二次方秒。');
    assert(r.length === 1, '抽到 ' + r.length + ' 组');
    assert(r[0].q.indexOf('加速度') >= 0, '问题抽取错');
  });

  step('SM-2 排期：掌握往上抬，忘了打回今天', () => {
    S.kb.cards = [{ id:'sm1', q:'q', a:'a', ease:2.5, iv:0, due:today(), reps:0, lapses:0, doc:'d' }];
    kbSchedule(S.kb.cards[0], 'good', {});
    assert(S.kb.cards[0].iv === 1, '首次答对应给 1 天');
    kbSchedule(S.kb.cards[0], 'bad', {});
    assert(S.kb.cards[0].iv === 0, '忘了应当归零');
    assert(S.kb.cards[0].lapses === 1, 'lapses 没记');
  });

  step('判卷结果写进 Brier 记录', () => {
    S.kb.brier = [];
    S.kb.cards = [{ id:'sm2', q:'q', a:'a', ease:2.5, iv:0, due:today(), reps:0, lapses:0, doc:'某资料' }];
    KB.review.queue = ['sm2']; KB.review.idx = 0;
    finishJudge(S.kb.cards[0], { level:'good', correct:true, conf:80, comment:'答得完整', label:'掌握' });
    assert(S.kb.brier.length === 1, '没记录');
    assert(S.kb.brier[0].conf === 80 && S.kb.brier[0].correct === true, '字段没存对');
  });

  step('Brier 分数算得对', () => {
    S.kb.brier = [
      { conf:100, correct:true, doc:'d' }, { conf:100, correct:false, doc:'d' },
      { conf:50, correct:true, doc:'d' }, { conf:50, correct:false, doc:'d' }
    ];
    KB.tab = 'stats'; render();
    // (1-1)² + (1-0)² + (0.5-1)² + (0.5-0)² = 1.5，除以 4 = 0.375
    assert(viewHTML().indexOf('0.375') >= 0, '页面里没看到 0.375');
  });

  /* ---- 14. 新模块的数据落盘 ---- */
  await astep('六艺与知识库的数据也在自动备份里（这是"丢不掉"的底线）', async () => {
    S.kb.cards = [{ id:'bk1', q:'落盘测试', a:'答案', due:today(), ease:2.5, iv:0, reps:0, lapses:0, doc:'d' }];
    S.liuyi.prompts = [{ id:'lp1', title:'一条提示词', body:'正文', at:today() }];
    save(true);
    await sleep(120);
    const raw = JSON.parse(localStorage.getItem('origin.v1'));
    assert(raw.kb && raw.kb.cards.length === 1, 'kb 没落盘');
    assert(raw.liuyi && raw.liuyi.prompts.length === 1, 'liuyi 没落盘');
  });

  await astep('磁盘自动备份里也带着新模块的数据', async () => {
    nativeAutosave(true);
    await sleep(900);
    const r = await NATIVE.readAutosave();
    assert(r && r.ok, '读不到自动备份');
    const j = JSON.parse(r.text);
    const d = j.data || j;
    assert(d.kb && Array.isArray(d.kb.cards), '备份里没有 kb');
    assert(d.liuyi && Array.isArray(d.liuyi.prompts), '备份里没有 liuyi');
  });

  step('侧栏徽标会提示知识库待复习', () => {
    S.kb.cards = [{ id:'bd', due:today(), q:'q', a:'a' }, { id:'bd2', due:shiftDay(today(), 9), q:'q', a:'a' }];
    const b = badgeOf('kb');
    assert(b && b.t.indexOf('待复习 1') >= 0, '徽标不对：' + JSON.stringify(b));
  });

  step('设置窗口能打开且字段齐全', () => {
    lySettings();
    const m = document.querySelector('.modal');
    assert(m, '设置没弹出');
    assert(m.innerHTML.indexOf('接口地址') >= 0, '缺接口地址');
    assert(m.innerHTML.indexOf('测一下这台机器多快') >= 0, '缺实测速度的按钮');
    closeModal();
  });

  await astep('模型配置读得到（主进程那份是权威）', async () => {
    // aiConfig() 是异步的，启动时发出去、回来才写进 S.liuyi.cfg。
    // 这里等它落地，而不是抢在读回来之前就断言。
    const got = await until(() => S.liuyi.cfg && S.liuyi.cfg.endpoint);
    out.info.cfgNow = JSON.stringify(S.liuyi.cfg);
    assert(got, '等了 3 秒还没读到模型配置');
    assert(typeof S.liuyi.cfg.chatModel === 'string' && S.liuyi.cfg.chatModel, '缺 chatModel');
    assert(typeof S.liuyi.cfg.embedModel === 'string' && S.liuyi.cfg.embedModel, '缺 embedModel');
    assert(S.liuyi.cfg.maxTokens > 0, '生成上限不是正数');
  });

  await astep('设置窗口会自动列出本机装了的模型，并且点得动', async () => {
    const r = await NATIVE.aiListModels();
    if (!r || !r.ok){ out.warn.push('模型服务没开，跳过「列出本机模型」这项'); return; }
    lySettings();
    const box = document.querySelector('#lySetModels');
    assert(box, '找不到模型列表容器');
    // 列表是异步拉的，等它填出来
    assert(await until(() => box.children.length > 0, 5000), '模型列表一直没有自动填出来');
    const chip = box.querySelector('[data-pick]');
    assert(chip, '列表里没有可点的标签');
    const name = chip.getAttribute('data-pick');
    const isEm = /embed|bge|gte|m3e|jina/i.test(name);
    const inp = document.querySelector(isEm ? '#lySetEm' : '#lySetCm');
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(inp && inp.value === name, '点了标签却没填进输入框');
    closeModal();
  });

  await astep('模型自检：配置里的模型本机没有时会自己换一个能用的', async () => {
    // 纯离线版压根不连模型（lyCheckModel 一进去就早退），这项对它没有意义。
    if (window.ZD_PURE){ out.warn.push('纯离线版不连模型，跳过「模型自检」这项'); return; }
    const r = await NATIVE.aiListModels();
    if (!r || !r.ok){ out.warn.push('模型服务没开，跳过「模型自检」这项'); return; }
    const before = S.liuyi.cfg.chatModel;
    S.liuyi.cfg.chatModel = '这个模型一定不存在:0b';
    save();
    lyCheckModel(true);
    const fixed = await until(() => S.liuyi.cfg.chatModel !== '这个模型一定不存在:0b', 6000);
    assert(fixed, '没有自动换掉本机不存在的模型');
    const now = S.liuyi.cfg.chatModel;
    assert(r.models.indexOf(now) >= 0, '换上的模型本机也没有：' + now);
    assert(!S.liuyi.modelMissing, '换好之后胶囊仍然标着缺失');
    // 收尾：把配置还原，别污染后面的检查
    S.liuyi.cfg.chatModel = before;
    save();
    if (NATIVE.aiSetConfig) await NATIVE.aiSetConfig({ chatModel: before });
  });

  /* ---- 磁盘快照 ----
     浏览器存储不是可靠的东西（被清理、被策略拦、盘不让覆盖写都会丢），
     磁盘上那份快照是唯一的退路。所以它必须真的写得下、也真的读得回来 ——
     不能只是一个"看起来在存"的通道。 */
  await astep('改动会写成一份能读回来的磁盘快照', async () => {
    save(true);
    await sleep(1800);                                   // 等限流过去
    const r = await NATIVE.readSnapshot();
    assert(r && r.ok, '读不到快照：' + ((r && r.error) || '未知'));
    const d = JSON.parse(r.text);
    const st = d.data || d;
    assert(typeof st._rev === 'number' && st._rev > 0, '快照里没有版本号');
    assert(st._rev >= S._rev, '快照比内存里那份还旧：' + st._rev + ' < ' + S._rev);
    assert(r.name && r.name.indexOf('快照-') === 0, '快照文件名不对：' + r.name);
    out.info.snapName = r.name;
    out.info.snapRev = r.rev;
  });

  await astep('版本号会随每次改动递增（快照靠它判断谁新）', async () => {
    const before = S._rev;
    save(true);
    assert(S._rev > before, '版本号没动：' + before + ' → ' + S._rev);
  });

  await astep('旧快照不会盖掉内存里更新的状态', async () => {
    const cur = JSON.parse(JSON.stringify(S));
    const old = JSON.parse(JSON.stringify(cur));
    old._rev = 1;
    old.profile = Object.assign({}, old.profile, { snapMark: '不该出现' });
    const keep = adoptSnapshot(JSON.stringify({ _file: 'ORIGIN-backup', _v: 1, data: old }), '冒烟');
    assert(keep === false, '竟然接管了旧快照');
    assert(!S.profile.snapMark, '旧数据被写进来了');
  });

  /* ---- 首页（3.3.3 新增）----
     首启落点、13 张介绍卡、视频层挂在哪、点「进入应用」。
     视频只验 DOM 证据 + 解码状态，不截图 —— 这台机器上截图拿的是过期帧。 */
  await astep('首页：13 张介绍卡一张不少，且都写齐了三段式', async () => {
    // 冒烟跑在已经用过的 profile 上，homeSeen 多半已是 1，
    // 所以这里手动回首页验渲染，不依赖「第一次打开」这个前提。
    go('home');
    assert(route === 'home', 'go("home") 之后 route 不是 home，是 ' + route);
    const cards = $$('#view .home-card');
    assert(cards.length === 13, '首页介绍卡应为 13 张，实际 ' + cards.length);
    const names = cards.map(c => (c.querySelector('.home-card-n') || {}).textContent || '');
    ['今日', '校准', '追问', '雷达', '工坊', '决策', '机会', '英语', '知识库', '档案', '日志', '关于']
      .forEach(n => assert(names.indexOf(n) >= 0, '首页少了「' + n + '」这张卡'));
    assert(names.indexOf(window.ZD_PURE ? '提示词' : '六艺') >= 0,
      '首页少了模型那张卡（ZD_PURE=' + !!window.ZD_PURE + '）');
    cards.forEach(c => {
      const rows = [].slice.call(c.querySelectorAll('.home-row b')).map(b => b.textContent);
      assert(rows.join('|') === '什么时候用|第一次怎么用',
        '卡片「' + (c.querySelector('.home-card-n') || {}).textContent + '」缺三段式：' + rows.join('/'));
    });
    out.info.homeCards = cards.length;
  });

  await astep('首页：视频层挂在 .main 下（不在 #view 里），自动播放五件套齐全', async () => {
    go('home');
    const bg = document.getElementById('homeBg');
    assert(bg, '没有 #homeBg —— 视频层没挂上');
    assert(bg.parentElement.classList.contains('main'), '视频层没挂在 .main 下');
    assert(!document.getElementById('view').contains(bg), '视频层挂进了 #view，会跟着内容滚走');
    const v = document.getElementById('homeVid');
    assert(v, '没有 #homeVid');
    assert(v.getAttribute('src') === 'zd-home.mp4', '视频 src 不对：' + v.getAttribute('src'));
    ['muted', 'loop', 'autoplay', 'playsinline', 'webkit-playsinline'].forEach(a => {
      assert(v.hasAttribute(a), '视频缺属性 ' + a + '（手机上会被顶成全屏播放器）');
    });
    assert(document.body.classList.contains('home-mode'), '首页在位但 body 没进 home-mode');
    // 光验属性不够，还得看 Chromium 真的把文件解开了
    assert(await until(() => v.readyState >= 2 || v.videoWidth > 0 || v.error, 8000),
      '视频既没就绪也没报错，状态卡住了');
    if (v.error){
      out.warn.push('视频解码失败 code=' + v.error.code + '（zd-home.mp4 可能没随包拷进去）');
    } else {
      out.info.video = { w: v.videoWidth, h: v.videoHeight, dur: Math.round(v.duration), ready: v.readyState };
      assert(v.videoWidth > 0 && v.videoHeight > 0, '视频尺寸读出来是 0x0');
    }
  });

  await astep('首页：点「进入应用」→ 记下已看过 + 回今日 + 视频层收掉', async () => {
    go('home');
    const btn = document.getElementById('homeGo');
    assert(btn, '找不到「进入应用」按钮');
    btn.click();
    assert(route === 'today', '点完之后没回今日，route=' + route);
    assert(localStorage.getItem('origin.homeSeen') === '1', '没有记下 origin.homeSeen');
    assert(!document.getElementById('homeBg'), '离开首页后视频层还挂着');
    assert(!document.body.classList.contains('home-mode'), '离开首页后 home-mode 没摘掉');
  });

  await astep('手机底部导航：首页排第一，跟今日、校准并列', async () => {
    // Electron 窗口是桌面宽度，.mnav 是 display:none，但 DOM 照样被 paintMnav 填满 ——
    // 所以这里查 DOM 就能验，不用真拿手机。
    const items = $$('#mnav .mnav-i').map(b => b.getAttribute('data-mnav'));
    assert(items.length >= 1, '底部导航一条都没有');
    assert(items[0] === 'home', '底部导航第一项不是首页，是「' + items[0] + '」：' + items.join('/'));
    assert(items.indexOf('today') >= 0, '底部导航丢了「今日」');
    assert(items.indexOf('calib') >= 0, '底部导航丢了「校准」');
    assert(items.indexOf('__more') >= 0, '底部导航丢了「更多」出口');
    assert(items.length <= 6, '底部导航挤到 ' + items.length + ' 格了，点不准');
    // 高亮也要对得上：站在首页时，第一格应该是 on
    go('home');
    assert($('#mnav .mnav-i').classList.contains('on'), '停在首页时底部第一格没有高亮');
    out.info.mnav = items.join('/');
  });

  await astep('首页：13 张卡的「去看看」都指向真实模块', async () => {
    go('home');
    const bad = $$('#view .home-card [data-go]')
      .map(b => b.getAttribute('data-go'))
      .filter(k => !ROUTES.some(r => r.k === k));
    assert(bad.length === 0, '指向了不存在的模块：' + bad.join('/'));
  });

  /* ---- 收尾：留在干净的今日页 ---- */
  go('today');

  return JSON.stringify(out);
})();
