import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

test("successful local deletion enqueues cloud tombstones before cleanup; failure never enqueues", async (t) => {
  const temp=await mkdtemp(join(tmpdir(),"cloud-delete-ipc-"));
  const stub=join(temp,"electron.mjs");
  await writeFile(stub,"export const BrowserWindow={};export const dialog={};export const shell={};export const app={};");
  const vite=await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,resolve:{alias:{electron:stub}},server:{middlewareMode:true,hmr:false,ws:false},appType:"custom",optimizeDeps:{noDiscovery:true,include:[]}});
  t.after(async()=>{await vite.close();await rm(temp,{recursive:true,force:true});});
  const {registerSessionIpc}=await vite.ssrLoadModule("/electron/main/ipc/session-ipc.ts");
  for(const result of [{ok:true},{ok:false},new Error("Host failed")]){
    const handlers=new Map(),order=[];
    registerSessionIpc({registrar:{handle:(channel,fn)=>handlers.set(channel,fn)},
      getHost:()=>({async call(method){assert.equal(method,"session.delete");order.push("deleted");if(result instanceof Error)throw result;return result;}}),getSidecar:()=>null,
      persistenceOutbox:{async dropSession(){order.push("cleanup");}},forgetTranscriptRewriteHistory(){},sessionProjects:new Map(),logger:{app(){}},
      onSessionsDeleted(ids){assert.deepEqual(ids,["deleted-session"]);order.push("queued");},
    });
    const run=handlers.get(IPC.invoke.sessionDelete)("deleted-session");
    if(result instanceof Error)await assert.rejects(run);else await run;
    assert.deepEqual(order,result instanceof Error?["deleted"]:result.ok?["deleted","queued","cleanup"]:["deleted","cleanup"]);
  }
});
