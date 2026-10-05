'use strict';
/* 渲染层与系统之间的唯一通道。只暴露这几件事，别的一律不给。
   命名上刻意分了三组：
     app:*  文件与数据目录（应用已有的那些）
     ai:*   走主进程转发到本地模型，绕开 file:// 的跨源与混合内容限制
     kb:*   知识库的原文与索引落盘
   渲染层拿不到 require、拿不到 fs、拿不到任意路径读写 —— 只能调这几个函数。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ORIGIN_NATIVE', {
  /* ── 应用 ── */
  version: () => ipcRenderer.invoke('app:info'),
  saveBackup: (text, name) => ipcRenderer.invoke('app:saveBackup', text, name),
  openBackup: () => ipcRenderer.invoke('app:openBackup'),
  autosave: (text) => ipcRenderer.invoke('app:autosave', text),
  autosaveSync: (text) => ipcRenderer.sendSync('app:autosave-sync', text),
  readAutosave: () => ipcRenderer.invoke('app:readAutosave'),
  readSnapshot: () => ipcRenderer.invoke('app:readSnapshot'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  scanBackups: () => ipcRenderer.invoke('app:scanBackups'),
  importPath: (p) => ipcRenderer.invoke('app:importPath', p),
  importText: () => ipcRenderer.invoke('app:importText'),
  writeFile: (text, name, ext) => ipcRenderer.invoke('app:writeFile', text, name, ext),
  reveal: (p) => ipcRenderer.invoke('app:reveal', p),
  onMenu: (fn) => ipcRenderer.on('menu', (e, cmd) => fn(cmd)),
  onNav: (fn) => ipcRenderer.on('nav', (e, k) => fn(k)),

  /* ── AI ── */
  aiConfig: () => ipcRenderer.invoke('ai:config'),
  aiSetConfig: (patch) => ipcRenderer.invoke('ai:setConfig', patch),
  aiPing: () => ipcRenderer.invoke('ai:ping'),
  aiListModels: () => ipcRenderer.invoke('ai:listModels'),
  aiChat: (messages, opts) => ipcRenderer.invoke('ai:chat', messages, opts),
  aiEmbed: (texts) => ipcRenderer.invoke('ai:embed', texts),

  /* ── 知识库 ── */
  kbPickFiles: () => ipcRenderer.invoke('kb:pickFiles'),
  kbSaveFile: (name, text) => ipcRenderer.invoke('kb:saveFile', name, text),
  kbReadText: (name) => ipcRenderer.invoke('kb:readText', name),
  kbWriteIndex: (docId, json) => ipcRenderer.invoke('kb:writeIndex', docId, json),
  kbReadIndex: (docId) => ipcRenderer.invoke('kb:readIndex', docId),
  kbDeleteIndex: (docId) => ipcRenderer.invoke('kb:deleteIndex', docId),
  kbOpenDir: () => ipcRenderer.invoke('kb:openDir'),
  kbReveal: (p) => ipcRenderer.invoke('kb:reveal', p)
});
