// <spherum-api> Sessão do Supabase Auth e chamadas à API do Spherum (fonte: design/shared/spherum-api.js; o script scripts/design-bundle.mjs copia este bloco para os modelos).
const SP_SB = { url: 'https://fszbxwlxuncqefcwttru.supabase.co', key: 'sb_publishable_zAhuSdMR3g2zHAb7WwYyCQ_XW8CLEth' };
const SP_SESSION = 'spherum.session';
const SP = {
  get() { try { return JSON.parse(localStorage.getItem(SP_SESSION) || 'null'); } catch (e) { return null; } },
  save(d) {
    const s = d && d.access_token ? { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (+d.expires_in || 3600), user: d.user ? { id: d.user.id, email: d.user.email } : (SP.get() || {}).user || null } : null;
    try { if (s) localStorage.setItem(SP_SESSION, JSON.stringify(s)); else localStorage.removeItem(SP_SESSION); } catch (e) {}
    return s;
  },
  authMsg(j, status) {
    const c = String(j.error_code || j.code || j.error || ''), m = String(j.msg || j.message || j.error_description || '');
    if (/invalid_credentials|invalid_grant/.test(c) || /invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email_not_confirmed/.test(c) || /not confirmed/i.test(m)) return 'Confirme o seu e-mail pelo link que enviamos antes de entrar.';
    if (/user_already_exists|email_exists/.test(c) || /already registered/i.test(m)) return 'Este e-mail já tem conta. Entre com ele.';
    if (/weak_password/.test(c) || /password/i.test(m) && status === 422) return 'Senha fraca: use pelo menos 8 caracteres, com letras e números.';
    if (/rate_limit/.test(c) || status === 429) return 'Muitas tentativas seguidas. Espere um pouco e tente de novo.';
    if (/email_address_invalid|validation_failed/.test(c)) return 'Confira o e-mail digitado.';
    return 'Não deu certo agora. Tente de novo em instantes.';
  },
  async auth(path, body, token) {
    const h = { apikey: SP_SB.key, 'content-type': 'application/json' };
    if (token) h.authorization = 'Bearer ' + token;
    const r = await fetch(SP_SB.url + '/auth/v1/' + path, { method: path === 'user' ? 'PUT' : 'POST', headers: h, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(SP.authMsg(j, r.status)); e.status = r.status; throw e; }
    return j;
  },
  back(q) { return location.origin + '/' + (q || ''); },
  async login(email, password) { return SP.save(await SP.auth('token?grant_type=password', { email, password })); },
  // Com confirmação de e-mail ligada no Supabase, volta sem sessão: a pessoa confirma pelo link.
  async signup(email, password, data, q) { const j = await SP.auth('signup?redirect_to=' + encodeURIComponent(SP.back(q || '?confirmado=1')), { email, password, data }); return j.access_token ? SP.save(j) : null; },
  async recover(email) { await SP.auth('recover?redirect_to=' + encodeURIComponent(SP.back('?redefinir=1')), { email }); },
  async setPassword(password) { const t = await SP.token(); if (!t) throw new Error('O link venceu. Peça outro em "Esqueci minha senha".'); await SP.auth('user', { password }, t); },
  // Volta do link do e-mail (confirmação ou nova senha): a sessão vem no fragmento da URL.
  fromLink() {
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    if (!h.get('access_token')) return null;
    const s = SP.save({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in'), expires_at: +h.get('expires_at') || undefined });
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    return s ? h.get('type') || 'login' : null;
  },
  async token() {
    let s = SP.get();
    if (!s) return null;
    if (s.expires_at - 60 < Date.now() / 1000) {
      try { s = SP.save(await SP.auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token })); } catch (e) { SP.save(null); return null; }
    }
    return s.access_token;
  },
  async api(path, o) {
    o = o || {};
    const t = await SP.token(), h = { 'content-type': 'application/json' };
    if (t) h.authorization = 'Bearer ' + t;
    const r = await fetch(location.origin + path, { method: o.method || 'GET', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Não deu certo agora. Tente de novo em instantes.'); e.status = r.status; e.body = j; throw e; }
    return j;
  },
  logout() {
    const s = SP.get();
    SP.save(null);
    if (s) fetch(SP_SB.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: SP_SB.key, authorization: 'Bearer ' + s.access_token } }).catch(() => {});
  }
};
// </spherum-api>
