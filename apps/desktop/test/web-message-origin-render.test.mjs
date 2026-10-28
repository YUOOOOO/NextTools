import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { build } = createRequire(join(root,"package.json"))("esbuild");
test("user source chip uses localized metadata styling and never labels local or assistant rows", async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "web-origin-render-"));
  try {
    const file = join(temp,"fixture.mjs");
    await build({ stdin: { contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './packages/i18n/src/locales/en/index.ts';
import { zhCN } from './packages/i18n/src/locales/zh-CN/index.ts';
import { UserMessageSource } from './apps/desktop/src/features/chat/transcript/UserMessageSource.tsx';
await i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:en},'zh-CN':{translation:zhCN}},interpolation:{escapeValue:false}});
export async function render(message,locale){await i18n.changeLanguage(locale);return renderToStaticMarkup(React.createElement(UserMessageSource,{message}));}
`, resolveDir: root, loader:"tsx" }, outfile:file, bundle:true, platform:"node",format:"esm", banner: { js: "import { createRequire as __originRequire } from 'node:module'; const require = __originRequire(import.meta.url);" }, alias: {
      react:join(root,"apps/desktop/node_modules/react"),"react-dom":join(root,"apps/desktop/node_modules/react-dom"),i18next:join(root,"apps/desktop/node_modules/i18next"),"react-i18next":join(root,"apps/desktop/node_modules/react-i18next"),
    } });
    const { render } = await import(pathToFileURL(file).href);
    const web = { role:"user", inputSource:"web" };
    assert.match(await render(web,"zh-CN"),/来自网页/);
    assert.match(await render(web,"en"),/From web/);
    assert.match(await render(web,"en"),/message-meta-chip/);
    assert.match(await render(web,"en"),/data-input-source="web"/);
    assert.equal(await render({role:"user"},"en"),"");
    assert.equal(await render({role:"assistant",inputSource:"web"},"en"),"");
    assert.equal(await render({role:"tool",inputSource:"web"},"en"),"");
    assert.equal(await render({role:"user",inputSource:"desktop"},"en"),"");
    // Source stays a label after a JSON transcript reload, never visible body text.
    assert.match(await render(JSON.parse(JSON.stringify(web)),"zh-CN"),/来自网页/);
  } finally { await rm(temp,{recursive:true,force:true}); }
});
