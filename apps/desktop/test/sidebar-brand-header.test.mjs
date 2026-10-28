import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { build } = createRequire(join(root, "package.json"))("esbuild");
const browserPath = process.env.SIDEBAR_TEST_BROWSER || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => existsSync(path));

test("shared sidebar header spans the navigation columns and preserves collapse/home hit targets", { skip: !browserPath, timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "sidebar-header-browser-"));
  const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { catalogs, flattenCatalog } from '@pi-desktop/i18n';
import { SidebarBrandHeader } from './SidebarBrandHeader';
await i18n.use(initReactI18next).init({lng:'en',keySeparator:false,resources:{en:{translation:flattenCatalog(catalogs.en)}},interpolation:{escapeValue:false}});
window.headerActions={home:0,toggle:0};
function Fixture(){
 const [collapsed,setCollapsed]=useState(false),[page,setPage]=useState('chat');
 return <div className={'app-shell'+(collapsed?' sidebar-collapsed':'')} style={{'--ds-sidebar-width':'240px'}}>
  {!collapsed && <SidebarBrandHeader sidebarToggleShortcut="Ctrl+B" onHome={()=>{window.headerActions.home++;setPage('chat')}} onToggleSidebar={()=>{window.headerActions.toggle++;setCollapsed(true)}}/>}
  <nav className="activity-bar"><div className="activity-bar-top"><button className="activity-bar-button" data-route="chat" onClick={()=>setPage('chat')}>Chat</button><button className="activity-bar-button" data-route="workbench" onClick={()=>setPage('workbench')}>Work</button></div></nav>
  <div className="app-chat-shell">{!collapsed&&<aside className={'sidebar sidebar-surface'+(page==='workbench'?' workbench-menu':'')}><div className="sidebar-body"><button data-secondary="item">{page==='chat'?'Project conversations':'Workbench pages'}</button></div><div className="sidebar-resize-handle"/></aside>}
   <main className="main-pane">{collapsed&&<button data-nav="expand-sidebar" onClick={()=>setCollapsed(false)}>Expand</button>}</main></div>
 </div>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
  const bundle = join(temp, "fixture.js");
  await build({ stdin: { contents: fixture, resolveDir: join(root, "apps/desktop/src/features/app"), loader: "tsx" }, outfile: bundle,
    bundle: true, platform: "browser", format: "esm", loader: { ".png": "dataurl" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"), "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root,"apps/desktop/node_modules/react"),"react-dom":join(root,"apps/desktop/node_modules/react-dom"),
      i18next:join(root,"apps/desktop/node_modules/i18next"),"react-i18next":join(root,"apps/desktop/node_modules/react-i18next") } });
  const css = (await Promise.all(["tokens.css","base.css","chrome.css","activity-bar.css","ui-kit.css","theme-overrides.css","responsive.css"].map((name)=>readFile(join(root,"apps/desktop/src/styles",name),"utf8")))).join("\n");
  const javascript = await readFile(bundle);
  const html = '<!doctype html><html data-platform="win32" data-theme="light"><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  const server = createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(javascript);}else if(req.url==='/fixture.css'){res.setHeader('content-type','text/css');res.end(css);}else if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}else{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = spawn(browserPath,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${temp}/profile`,"about:blank"],{stdio:'ignore',windowsHide:true});
  let socket, count=0; const pending=new Map();
  const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
  async function until(fn,message){const end=Date.now()+15000;while(Date.now()<end){const value=await fn();if(value)return value;await pause();}throw new Error(message);}
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++count;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;}
  try{
    const port=await until(async()=>{try{return(await readFile(join(temp,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},'Browser did not start');
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message',({data})=>{const msg=JSON.parse(String(data)),entry=pending.get(msg.id);if(!entry)return;clearTimeout(entry.timer);pending.delete(msg.id);if(msg.error)entry.reject(new Error(JSON.stringify(msg.error)));else entry.resolve(msg.result);});
    await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    await until(()=>evaluate("!!document.querySelector('.sidebar-brand-header')"),'Header missing');
    for(const width of [240,360]){
      await evaluate(`document.querySelector('.app-shell').style.setProperty('--ds-sidebar-width','${width}px')`);
      const geometry=await evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return{header:rect('.sidebar-brand-header'),brand:rect('.brand'),toggle:rect('[data-nav=toggle-sidebar]'),rail:rect('.activity-bar'),item:rect('.activity-bar-button'),body:rect('.sidebar-body'),resize:rect('.sidebar-resize-handle'),drag:getComputedStyle(document.querySelector('.sidebar-brand-header')).webkitAppRegion,noDrag:getComputedStyle(document.querySelector('.brand')).webkitAppRegion,buttonHit:document.elementFromPoint(document.querySelector('[data-nav=toggle-sidebar]').getBoundingClientRect().x+10,20)?.closest('[data-nav=toggle-sidebar]')!==null}})()`);
      assert.equal(geometry.header.x,0);assert.equal(geometry.header.width,48+width);
      assert(geometry.brand.x<20,'Brand still starts after activity rail');
      assert.equal(geometry.toggle.right,48+width-8,'Collapse button moved horizontally');
      assert(geometry.item.y>=geometry.header.bottom,'Activity item overlaps header');
      assert(geometry.body.y>=geometry.header.bottom,'Secondary menu overlaps header');
      assert(geometry.resize.y>=geometry.header.bottom,'Resize hit target overlaps header');
      assert.equal(geometry.drag,'drag');assert.equal(geometry.noDrag,'no-drag');assert(geometry.buttonHit);
    }
    await evaluate("document.querySelector('[data-route=workbench]').click()");
    await until(()=>evaluate("document.querySelector('[data-secondary=item]')?.textContent === 'Workbench pages'"),'Route did not switch');
    assert.equal(await evaluate("document.querySelectorAll('.sidebar-brand-header').length"),1);
    await evaluate("document.querySelector('[data-nav=home]').click()");
    await until(()=>evaluate("document.querySelector('[data-secondary=item]')?.textContent === 'Project conversations'"),'Home failed');
    await evaluate("document.querySelector('[data-nav=toggle-sidebar]').click()");
    await until(()=>evaluate("!document.querySelector('.sidebar-brand-header') && !!document.querySelector('[data-nav=expand-sidebar]')"),'Collapse failed');
    await evaluate("document.querySelector('[data-nav=expand-sidebar]').click()");
    await until(()=>evaluate("!!document.querySelector('.sidebar-brand-header')"),'Expand failed');
    assert.deepEqual(await evaluate('window.headerActions'),{home:1,toggle:1});
    await evaluate("document.documentElement.dataset.platform='darwin'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.brand')).display"),'none');
    if(process.env.SIDEBAR_TEST_SCREENSHOT){await evaluate("document.documentElement.dataset.platform='win32'");const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(process.env.SIDEBAR_TEST_SCREENSHOT,Buffer.from(image.data,'base64'));}
  }finally{
    if(socket?.readyState===1){try{await call('Browser.close');}catch{}}
    socket?.close();browser.kill();for(const entry of pending.values())clearTimeout(entry.timer);
    await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
