import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(repo, path), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts;
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

for (const fail of [false, true]) {
  test(`shared asset entry executes each bundle once and ${fail ? 'stops on failure' : 'completes'}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'nexttools-assets-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'record.cjs'), `require('node:fs').appendFileSync('calls',process.argv[2]+'\\n'); if(process.argv[2]==='bridge' && ${fail})process.exit(1);`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
      'build:assets': scripts['build:assets'],
      ...Object.fromEntries(['web', 'server', 'bridge', 'cli'].map(name => [`build:${name}`, `node record.cjs ${name}`])),
    } }));
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:assets'], {
      cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 30_000,
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.equal(readFileSync(join(root, 'calls'), 'utf8'), fail ? 'web\nserver\nbridge\n' : 'web\nserver\nbridge\ncli\n');
  });
}

test('direct Tauri builds retain the public asset hook', () => {
  assert.equal(config.build.beforeBuildCommand, 'npm run build:assets');
});

test('explicit platform builds prepare assets before disabling only the invocation hook', () => {
  for (const file of ['build_macos.sh', 'build_dev.sh', 'build_windows.ps1', 'build_dev_win.ps1']) {
    const source = read(file);
    // Release builds also refresh the local bundles after restoring the host DSH.
    assert.equal(source.match(/npm run build:assets\b/g)?.length, file === 'build_macos.sh' ? 2 : 1, file);
    assert.doesNotMatch(source, /npm run build:(?:web|server|bridge|cli)\b/, file);
    assert.match(source, /"beforeBuildCommand"\s*:\s*null/, file);
    const build = source.indexOf('npm run build:assets');
    const tauri = source.indexOf('npm run tauri:build');
    assert.ok(build < tauri, `${file}: assets must finish before Tauri`);
    assert.match(source.slice(tauri).split('\n')[0], /--config/, file);
    if (file === 'build_macos.sh') {
      assert.ok(build > source.indexOf('for TARGET in "${BUILD_TARGETS[@]}"; do', source.indexOf('REQUIRED_SDK_ARCHES=')));
      assert.ok(source.lastIndexOf('npm run build:assets') > tauri);
    }
  }
});

test('Linux keeps one default hook per build and all release platforms share sharp preparation', () => {
  const linux = read('build_linux.sh').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(linux, /beforeBuildCommand|npm run build:assets|npm run build:web/);
  for (const [file, os] of [['build_macos.sh', 'darwin'], ['build_windows.ps1', 'win32'], ['build_linux.sh', 'linux']]) {
    assert.match(read(file), new RegExp(`npm run build:sharp-runtime -- ${os}`));
  }
});

test('Unix entry points retain valid shell syntax', () => {
  if (process.platform === 'win32') return;
  for (const file of ['setup.sh', 'build_macos.sh', 'build_dev.sh', 'build_linux.sh', 'build_dev_linux.sh']) {
    const result = spawnSync('bash', ['-n', join(repo, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('development builds preserve Cargo source freshness and executable reuse', () => {
  for (const file of ['build_dev.sh', 'build_dev_win.ps1', 'build_dev_linux.sh', 'build_linux.sh']) {
    const source = read(file).replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(source, /\btouch\b[^\n]*\.rs|\.LastWriteTime\s*=/, file);
    assert.doesNotMatch(source, /rm\s+-f[^\n]*\/debug\/(?:app|nexttools)["\s]|\$oldExe/, file);
  }
});

test('Rust cleanup is explicit, scoped to local target, and supports Cargo dry-run', () => {
  assert.equal(scripts['clean:rust:app'], 'cargo clean --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target --profile dev -p nexttools');
  assert.equal(scripts['clean:rust'], 'cargo clean --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target');
  for (const file of ['build_dev.sh', 'build_dev_win.ps1', 'build_dev_linux.sh', 'build_linux.sh']) {
    assert.doesNotMatch(read(file), /cargo clean|npm run clean:rust/);
  }
});

test('Vite serves API source modules with hot-update queries without proxying them', async t => {
  const { createServer: createViteServer } = await import('vite');
  const { createServer: createHttpServer } = await import('node:http');
  const vite = await createViteServer({
    configFile: join(repo, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] }, preTransformRequests: false },
    logLevel: 'silent',
  });
  t.after(() => vite.close());
  const http = createHttpServer(vite.middlewares);
  t.after(() => new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  for (const query of ['', '?t=1792169069898', '?import&t=1792169069898']) {
    const response = await fetch(`${origin}/api/spaceCloud.ts${query}`);
    assert.equal(response.status, 200, query);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /DEFAULT_SPACE_ID/);
  }
  const proxyRoute = Object.keys(vite.config.server.proxy).find(route => route.startsWith('^/api/'));
  assert.ok(new RegExp(proxyRoute).test('/api/status?file=example.ts'));
});
