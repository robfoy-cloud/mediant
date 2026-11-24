import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://veoxasldburbztzucyrn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Gwnaqzgzz-Abvn5hiQvhsw_32P5goIo';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, detectSessionInUrl: true, storageKey: 'mediant-auth' },
});

const $ = (id) => document.getElementById(id);
const state = { user: null, session: null, members: [], channel: null, tab: 'private' };

// ---------- helpers ----------

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
  $(`view-${view}`).classList.remove('hidden');
  $('back').classList.toggle('hidden', view !== 'session');
  $('signout').classList.toggle('hidden', view === 'signin');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function errText(e) {
  const m = e?.message || String(e);
  return m.replace(/^.*?ERROR:\s*/, '');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const nameOf = (id) => state.members.find((m) => m.user_id === id)?.display_name || 'Partner';
const savedName = () => localStorage.getItem('mediant-name') || '';

async function api(path, body) {
  const { data } = await sb.auth.getSession();
  const r = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.error) throw new Error(out.error || `Error ${r.status}`);
  return out;
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || '…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

// ---------- sign in ----------

$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  const btn = e.submitter;
  busy(btn, true, 'Checking…');
  try {
    const { data: ok, error } = await sb.rpc('md_can_sign_in', { p_email: email });
    if (error) throw error;
    if (!ok) { $('signin-msg').textContent = "That email hasn't been invited yet."; return; }
    const { error: e2 } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    if (e2) throw e2;
    $('form-email').classList.add('hidden');
    $('form-code').classList.remove('hidden');
    $('signin-msg').textContent = `We've emailed ${email}. Enter the code, or tap the link in the email.`;
  } catch (err) {
    $('signin-msg').textContent = errText(err);
  } finally { busy(btn, false); }
});

$('form-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  busy(btn, true, 'Signing in…');
  const { error } = await sb.auth.verifyOtp({ email: $('email').value.trim().toLowerCase(), token: $('code').value.trim(), type: 'email' });
  busy(btn, false);
  if (error) $('signin-msg').textContent = errText(error);
});

$('restart').addEventListener('click', () => {
  $('form-code').classList.add('hidden');
  $('form-email').classList.remove('hidden');
  $('signin-msg').textContent = '';
});

$('signout').addEventListener('click', async () => { leaveRealtime(); await sb.auth.signOut(); });

sb.auth.onAuthStateChange((_event, session) => {
  const was = state.user?.id;
  state.user = session?.user || null;
  if (!state.user) { show('signin'); return; }
  if (was !== state.user.id) route();
});

// ---------- home ----------

async function loadHome() {
  show('home');
  leaveRealtime();
  state.session = null;
  for (const id of ['new-name', 'join-name']) if (!$(id).value) $(id).value = savedName();

  const { data: allowed } = await sb.rpc('md_is_allowed');
  if (!allowed) {
    $('sessions').replaceChildren();
    $('no-sessions').textContent = "This email isn't on the invite list for Mediant.";
    $('no-sessions').classList.remove('hidden');
    return;
  }

  const { data: mine, error } = await sb.from('md_members').select('session_id, md_sessions(id, topic, created_at)').eq('user_id', state.user.id);
  if (error) return toast(errText(error));
  const list = $('sessions');
  list.replaceChildren();
  const rows = (mine || []).filter((r) => r.md_sessions).sort((a, b) => b.md_sessions.created_at.localeCompare(a.md_sessions.created_at));
  $('no-sessions').textContent = 'No sessions yet.';
  $('no-sessions').classList.toggle('hidden', rows.length > 0);
  for (const r of rows) {
    const li = el('li');
    const a = el('a', null, r.md_sessions.topic);
    a.href = `#s/${r.md_sessions.id}`;
    li.append(a, el('span', 'note', new Date(r.md_sessions.created_at).toLocaleDateString('en-GB')));
    list.append(li);
  }

  const { data: admin } = await sb.rpc('md_is_admin');
  $('admin-card').classList.toggle('hidden', !admin);
  if (admin) loadAllowed();
}

async function loadAllowed() {
  const { data } = await sb.from('md_allowed_emails').select('email,is_admin').order('added_at');
  const ul = $('allowed');
  ul.replaceChildren();
  for (const row of data || []) {
    const li = el('li', null);
    li.append(el('span', null, row.email + (row.is_admin ? ' (admin)' : '')));
    if (!row.is_admin) {
      const b = el('button', 'link danger', 'Remove');
      b.onclick = async () => {
        const { error } = await sb.from('md_allowed_emails').delete().eq('email', row.email);
        if (error) toast(errText(error)); else loadAllowed();
      };
      li.append(b);
    }
    ul.append(li);
  }
}

$('form-allow').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('allow-email').value.trim().toLowerCase();
  const { error } = await sb.from('md_allowed_emails').insert({ email, added_by: state.user.email });
  if (error) return toast(errText(error));
  $('allow-email').value = '';
  loadAllowed();
});

$('form-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('new-name').value.trim();
  localStorage.setItem('mediant-name', name);
  const { data, error } = await sb.rpc('md_create_session', { p_topic: $('new-topic').value, p_name: name });
  if (error) return toast(errText(error));
  $('new-topic').value = '';
  location.hash = `s/${data.id}`;
});

$('form-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('join-name').value.trim();
  localStorage.setItem('mediant-name', name);
  const { data, error } = await sb.rpc('md_join_session', { p_code: $('join-code').value, p_name: name });
  if (error) return toast(errText(error));
  $('join-code').value = '';
  location.hash = `s/${data}`;
});

// ---------- session ----------

async function openSession(id) {
  show('session');
  const { data: s, error } = await sb.from('md_sessions').select('id,topic,invite_code,status').eq('id', id).maybeSingle();
  if (error || !s) { toast('Session not found.'); location.hash = ''; return; }
  state.session = s;
  $('s-topic').textContent = s.topic;
  setTab(state.tab);
  await Promise.all([loadMembers(), loadPrivate(), loadDraft(), loadShares(), loadShared()]);
  joinRealtime(id);
}

async function loadMembers() {
  const { data } = await sb.from('md_members').select('user_id,display_name').eq('session_id', state.session.id).order('joined_at');
  state.members = data || [];
  $('s-people').textContent = state.members.map((m) => (m.user_id === state.user.id ? `${m.display_name} (you)` : m.display_name)).join(' and ');
  const waiting = state.members.length < 2;
  $('s-invite').classList.toggle('hidden', !waiting);
  if (waiting) $('s-invite').textContent = `Waiting for your partner. Their join code: ${state.session.invite_code}`;
}

function renderThread(box, rows, whoFn) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.replaceChildren();
  for (const r of rows) {
    const who = whoFn(r);
    const msg = el('div', `msg ${who.cls}`);
    msg.append(el('div', 'who', who.label), el('div', 'body', r.content));
    box.append(msg);
  }
  if (atBottom || rows.length < 4) box.scrollTop = box.scrollHeight;
}

async function loadPrivate() {
  const { data } = await sb.from('md_private_messages').select('id,role,content').eq('session_id', state.session.id).order('id');
  renderThread($('p-thread'), data || [], (r) => (r.role === 'user' ? { cls: 'me', label: 'You' } : { cls: 'mediator', label: 'Mediant' }));
}

async function loadDraft() {
  const { data } = await sb.from('md_drafts').select('content').eq('session_id', state.session.id).eq('author_id', state.user.id).maybeSingle();
  const has = !!data?.content;
  $('draft-box').classList.toggle('hidden', !has);
  if (has && document.activeElement !== $('draft-text')) $('draft-text').value = data.content;
}

async function loadShares() {
  const { data } = await sb.from('md_shares').select('id,author_id,content,created_at').eq('session_id', state.session.id).order('id');
  const ul = $('shares');
  ul.replaceChildren();
  for (const s of data || []) {
    const li = el('li', s.author_id === state.user.id ? 'mine' : 'theirs');
    li.append(el('strong', null, s.author_id === state.user.id ? 'You shared' : `${nameOf(s.author_id)} shared`), el('p', null, s.content));
    ul.append(li);
  }
  $('shares-box').classList.toggle('hidden', !(data || []).length);
}

async function loadShared() {
  const { data } = await sb.from('md_shared_messages').select('id,author_id,role,content').eq('session_id', state.session.id).order('id');
  renderThread($('s-thread'), data || [], (r) => {
    if (r.role === 'mediator') return { cls: 'mediator', label: 'Mediant' };
    if (r.role === 'system') return { cls: 'system', label: '' };
    return r.author_id === state.user.id ? { cls: 'me', label: 'You' } : { cls: 'them', label: nameOf(r.author_id) };
  });
}

function thinking(box, on) {
  box.querySelector('.thinking')?.remove();
  if (on) {
    const t = el('div', 'msg mediator thinking');
    t.append(el('div', 'who', 'Mediant'), el('div', 'body', 'Thinking…'));
    box.append(t);
    box.scrollTop = box.scrollHeight;
  }
}

$('p-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('p-input').value.trim();
  if (!text) return;
  const btn = e.submitter;
  busy(btn, true);
  const { error } = await sb.from('md_private_messages').insert({ session_id: state.session.id, role: 'user', content: text });
  if (error) { busy(btn, false); return toast(errText(error)); }
  $('p-input').value = '';
  await loadPrivate();
  thinking($('p-thread'), true);
  try { await api('private', { session_id: state.session.id }); } catch (err) { toast(errText(err)); }
  thinking($('p-thread'), false);
  busy(btn, false);
  loadPrivate();
});

$('draft-make').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, true, 'Drafting…');
  try { await api('draft', { session_id: state.session.id }); await loadDraft(); $('draft-box').scrollIntoView({ behavior: 'smooth' }); }
  catch (err) { toast(errText(err)); }
  busy(btn, false);
});

$('draft-share').addEventListener('click', async () => {
  const content = $('draft-text').value.trim();
  if (!content) return;
  if (!confirm(`Share this with ${state.members.find((m) => m.user_id !== state.user.id)?.display_name || 'your partner'}?`)) return;
  const { error } = await sb.from('md_shares').insert({ session_id: state.session.id, content });
  if (error) return toast(errText(error));
  await sb.from('md_drafts').delete().eq('session_id', state.session.id).eq('author_id', state.user.id);
  $('draft-text').value = '';
  toast('Shared.');
  loadDraft(); loadShares();
});

$('draft-discard').addEventListener('click', async () => {
  await sb.from('md_drafts').delete().eq('session_id', state.session.id).eq('author_id', state.user.id);
  $('draft-text').value = '';
  loadDraft();
});

$('p-clear').addEventListener('click', async () => {
  if (!confirm('Delete everything you have written in your private space for this session? This cannot be undone.')) return;
  const { error } = await sb.from('md_private_messages').delete().eq('session_id', state.session.id).eq('owner_id', state.user.id);
  if (error) return toast(errText(error));
  loadPrivate();
});

$('s-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('s-input').value.trim();
  if (!text) return;
  const btn = e.submitter;
  busy(btn, true);
  const { error } = await sb.from('md_shared_messages').insert({ session_id: state.session.id, role: 'user', content: text });
  if (error) { busy(btn, false); return toast(errText(error)); }
  $('s-input').value = '';
  await loadShared();
  thinking($('s-thread'), true);
  try { await api('shared', { session_id: state.session.id }); } catch (err) { toast(errText(err)); }
  thinking($('s-thread'), false);
  busy(btn, false);
  loadShared();
});

$('s-pause').addEventListener('click', async () => {
  const me = state.members.find((m) => m.user_id === state.user.id)?.display_name || 'Someone';
  const { error } = await sb.from('md_shared_messages').insert({
    session_id: state.session.id, role: 'system', content: `${me} asked for a pause. Take a breather; come back when you're both ready.`,
  });
  if (error) toast(errText(error)); else loadShared();
});

$('leave').addEventListener('click', async () => {
  if (!confirm('Leave this session? Your private messages in it will be deleted.')) return;
  await sb.from('md_private_messages').delete().eq('session_id', state.session.id).eq('owner_id', state.user.id);
  await sb.from('md_drafts').delete().eq('session_id', state.session.id).eq('author_id', state.user.id);
  const { error } = await sb.from('md_members').delete().eq('session_id', state.session.id).eq('user_id', state.user.id);
  if (error) return toast(errText(error));
  location.hash = '';
});

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('tab-private').classList.toggle('hidden', tab !== 'private');
  $('tab-shared').classList.toggle('hidden', tab !== 'shared');
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));

// ---------- realtime ----------

function joinRealtime(id) {
  leaveRealtime();
  const filter = `session_id=eq.${id}`;
  const on = (table, fn) => [{ event: '*', schema: 'public', table, filter }, fn];
  const ch = sb.channel(`mediant-${id}`);
  ch.on('postgres_changes', ...on('md_private_messages', () => loadPrivate()))
    .on('postgres_changes', ...on('md_drafts', () => loadDraft()))
    .on('postgres_changes', ...on('md_shares', () => loadShares()))
    .on('postgres_changes', ...on('md_shared_messages', () => loadShared()))
    .on('postgres_changes', ...on('md_members', () => loadMembers()))
    .subscribe();
  state.channel = ch;
}
function leaveRealtime() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
}

// Fall back to a refresh when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) {
    loadMembers(); loadPrivate(); loadDraft(); loadShares(); loadShared();
  }
});

// ---------- routing ----------

$('back').addEventListener('click', () => { location.hash = ''; });

function route() {
  if (!state.user) return show('signin');
  const m = location.hash.match(/^#s\/([0-9a-f-]{36})$/i);
  if (m) openSession(m[1]); else loadHome();
}
window.addEventListener('hashchange', route);
// The first onAuthStateChange event (INITIAL_SESSION) shows the right view on load.
