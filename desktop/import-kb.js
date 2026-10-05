/* ═══════════════════════════════════════════════════════════
   批量导入：把外部文件夹里的 txt / md 灌进知识库。

   这段代码跑在**渲染进程**里，由主进程在 ORIGIN_IMPORT=1 时注入。
   主进程负责读文件（Node 才能碰磁盘），这里只负责入库 ——
   复用应用自己的 kbIngest，和手动上传走的是同一条路。

   设计上刻意做到「幂等」和「失败不丢」：
     · 同名的资料已经在了就直接跳过，重复跑不会翻倍
     · 嵌入失败也把原文留下（ready=false），靠关键词照样搜得到
   ═══════════════════════════════════════════════════════════ */
window.__kbImportOne = function (name, text) {
  return new Promise(function (resolve) {
    var done = function (o) { try { resolve(JSON.stringify(o)); } catch (e) { resolve('{"ok":false}'); } };
    try {
      if (!text || !String(text).trim()) return void done({ ok: false, error: '空文件' });

      /* 先探一次嵌入服务。服务没起的话，后面 84 份会挨个失败、还都说不清为什么 ——
         不如在第一份上就把原因摊开。探通一次就缓存标记，后面不再重复探。 */
      if (!window.__kbEmbedReady) {
        lyCallEmbed(['预热']).then(function () {
          window.__kbEmbedReady = true;
          window.__kbImportOne(name, text).then(resolve);
        }).catch(function (e) {
          done({ ok: false, error: '嵌入服务不可用：' + String((e && e.message) || e) });
        });
        return;
      }

      /* 同名且索引已经建好 → 跳过，重跑不会翻倍。
         同名但索引没建起来（上一轮嵌入服务没起就是这种情况）→ 摘掉旧记录重来。
         不这么做的话，一次失败就永远补不上了 —— 那才是真的白干。 */
      var ex = S.kb.docs.filter(function (d) { return d.name === name; })[0];
      if (ex && ex.ready) return void done({ ok: true, skip: true });
      if (ex) {
        S.kb.docs = S.kb.docs.filter(function (d) { return d !== ex; });
        try { save(); } catch (e) {}
      }

      // kbIngest 里有一句 `if (!kbBody()) return` —— 不在知识库页它会直接放弃，
      // 所以每次入库前先把页面切过去，别让一千行逻辑白写。
      if (typeof route !== 'undefined' && route !== 'kb' && typeof go === 'function') go('kb');

      var before = S.kb.docs.length;
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (S.kb.docs.length > before && !KB.build.running) {
          clearInterval(iv);
          var d = S.kb.docs[S.kb.docs.length - 1];
          done({ ok: true, chunks: d.chunks || 0, ready: !!d.ready, embed: d.embed || '' });
        } else if (Date.now() - t0 > 240000) {
          clearInterval(iv);
          done({ ok: false, error: '单份超过 4 分钟' });
        }
      }, 300);

      kbIngest([{ name: name, text: text, bytes: text.length }], 0);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
    }
  });
};

/* 清空知识库记录。原文和索引文件由主进程删 —— 这里碰不到文件系统。
   只在 ORIGIN_IMPORT_RESET=1 时被调用，平时不会动用户的数据。 */
window.__kbReset = function () {
  var n = S.kb.docs.length;
  S.kb.docs = []; S.kb.cards = []; S.kb.brier = [];
  save();
  return JSON.stringify({ ok: true, cleared: n });
};

/* 把外面重建好的记录并进知识库。
   磁盘上的原文和索引都还在、只是"库里有哪几份"这一行清单丢了的时候用它 ——
   向量就在索引文件里，不需要重算，所以这个是秒完成的。 */
window.__kbAdopt = function (list) {
  var added = 0, skipped = 0;
  (list || []).forEach(function (r) {
    if (!r || !r.id) return;
    var ex = S.kb.docs.filter(function (d) { return d.id === r.id; })[0];
    if (ex) { skipped++; return; }
    S.kb.docs.push(r);
    added++;
  });
  if (added) { save(true); if (typeof kbResetCache === 'function') kbResetCache(); }
  return JSON.stringify({ ok: true, added: added, skipped: skipped, total: S.kb.docs.length });
};

window.__kbImportStat = function () {
  return JSON.stringify({
    docs: S.kb.docs.length,
    ready: S.kb.docs.filter(function (d) { return d.ready; }).length,
    cards: S.kb.cards.length
  });
};

'ready';
