(() => {
  'use strict';
  const bridge = window.pluginBridge;
  const $ = id => document.getElementById(id);
  const copy = {
    en: { title:'Cloud Sync', scope:'Only conversation text and metadata are synced. Attachments and provider credentials stay on this device. Remote sensitive actions still require local consent.', server:'Server', account:'Account', password:'Password', login:'Sign in', register:'Register', status:'Status', counts:'Synced', push:'Sync now', logout:'Sign out', console:'Open web console', clear:'Clear error', enabled:'Automatic sync enabled', disabled:'Sync disabled on server', done:'Updated', busy:'Working…', failed:'The request failed. Check the server, credentials, and connection.', conversations:'conversations', messages:'messages' },
    zh: { title:'云同步', scope:'仅同步会话文本与元数据。附件和模型服务凭据保留在本机。敏感远程操作仍需本机确认。', server:'服务地址', account:'账号', password:'密码', login:'登录', register:'注册', status:'状态', counts:'已同步', push:'立即同步', logout:'退出登录', console:'打开网页控制台', clear:'清除错误', enabled:'自动同步已启用', disabled:'服务端同步已关闭', done:'已更新', busy:'处理中…', failed:'请求失败，请检查服务地址、账号密码和网络连接。', conversations:'个会话', messages:'条消息' }
  };
  let strings = copy.en, state = { signedIn:false }, busy = false;
  function appearance(value) {
    strings = /^zh/i.test(value?.locale || '') ? copy.zh : copy.en;
    document.documentElement.lang = strings === copy.zh ? 'zh-CN' : 'en';
    document.documentElement.dataset.theme = value?.base === 'dark' ? 'dark' : 'light';
    document.querySelectorAll('[data-text]').forEach(node => { node.textContent = strings[node.dataset.text]; });
    render();
  }
  function render() {
    $('account-form').hidden = state.signedIn;
    $('signed-in').hidden = !state.signedIn;
    $('saved-server').textContent = state.baseUrl || '';
    $('saved-account').textContent = state.account || '';
    $('status').textContent = state.state?.enabled ? strings.enabled : strings.disabled;
    $('counts').textContent = `${Number(state.state?.counts?.conversations || 0)} ${strings.conversations} · ${Number(state.state?.counts?.messages || 0)} ${strings.messages}`;
    document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  }
  function clearError() { $('error').hidden = true; $('error').textContent = ''; $('clear-error').hidden = true; }
  async function run(method, input) {
    if (busy) return;
    busy = true; clearError(); $('feedback').textContent = strings.busy; render();
    try {
      const result = await bridge.invoke(method, input || {});
      if (result && typeof result.signedIn === 'boolean') state = result;
      $('feedback').textContent = strings.done;
      if (result?.lastError) {
        $('error').textContent = strings.failed; $('error').hidden = false; $('clear-error').hidden = false;
        $('feedback').textContent = '';
      }
    } catch {
      // Never display remote error bodies, which can contain credentials.
      $('error').textContent = strings.failed; $('error').hidden = false; $('clear-error').hidden = false;
      $('feedback').textContent = '';
    } finally { $('password').value = ''; busy = false; render(); }
  }
  function authenticate(method) {
    if (!$('account-form').reportValidity()) return;
    void run(method, { baseUrl:$('server').value.trim(), account:$('account').value.trim(), password:$('password').value });
  }
  $('account-form').addEventListener('submit', event => { event.preventDefault(); authenticate('signIn'); });
  $('register').addEventListener('click', () => authenticate('register'));
  $('push').addEventListener('click', () => void run('push'));
  $('logout').addEventListener('click', () => void run('signOut'));
  $('console').addEventListener('click', () => void run('openConsole'));
  $('clear-error').addEventListener('click', clearError);
  if (bridge) {
    bridge.on('appearance:changed', appearance);
    void bridge.invoke('app.getAppearance').then(appearance).catch(() => appearance(null));
    void run('getState');
  } else { $('error').textContent = strings.failed; $('error').hidden = false; }
})();
