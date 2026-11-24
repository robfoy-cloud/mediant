// Mediant Worker: serves the app from /public and runs the mediator at /api/*.
// It acts with the caller's own Supabase session, so database privacy rules (RLS)
// limit every read to what that person may see. Mediator messages are written through
// md_worker_write, which also checks MEDIANT_WORKER_KEY.

import { privatePrompt, draftPrompt, sharedPrompt } from './prompts.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    try {
      const jwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!jwt) return json({ error: 'Sign in first' }, 401);
      const user = await getUser(env, jwt);
      if (!user) return json({ error: 'Sign in again' }, 401);

      const body = await request.json().catch(() => ({}));
      const sessionId = String(body.session_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return json({ error: 'Bad session' }, 400);

      const ctx = await loadContext(env, jwt, user.id, sessionId);
      if (!ctx) return json({ error: 'Session not found' }, 404);

      if (url.pathname === '/api/private') return json(await privateReply(env, jwt, ctx));
      if (url.pathname === '/api/draft') return json(await draftSummary(env, jwt, ctx));
      if (url.pathname === '/api/shared') return json(await sharedReply(env, jwt, ctx));
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.publicMessage || 'Something went wrong. Please try again.' }, 500);
    }
  },
};

// ---------- Supabase (as the signed-in user) ----------

async function getUser(env, jwt) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_KEY, authorization: `Bearer ${jwt}` },
  });
  return r.ok ? r.json() : null;
}

async function db(env, jwt, path, init = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_KEY,
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    const e = new Error(`Supabase ${r.status}: ${text}`);
    if (text.includes('Not a member') || text.includes('Not invited')) e.publicMessage = 'You are not part of this session.';
    throw e;
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const write = (env, jwt, kind, sessionId, content) =>
  db(env, jwt, 'rpc/md_worker_write', {
    method: 'POST',
    body: JSON.stringify({ p_key: env.MEDIANT_WORKER_KEY, p_kind: kind, p_session: sessionId, p_content: content }),
  });

async function loadContext(env, jwt, userId, sessionId) {
  const q = `session_id=eq.${sessionId}`;
  const [sessions, members, shares] = await Promise.all([
    db(env, jwt, `md_sessions?id=eq.${sessionId}&select=id,topic,status`),
    db(env, jwt, `md_members?${q}&select=user_id,display_name`),
    db(env, jwt, `md_shares?${q}&select=author_id,content&order=id.asc`),
  ]);
  if (!sessions?.length) return null; // RLS: not a member
  const me = members.find((m) => m.user_id === userId);
  const partner = members.find((m) => m.user_id !== userId);
  return {
    sessionId,
    userId,
    topic: sessions[0].topic,
    me: me?.display_name || 'You',
    partner: partner?.display_name || null,
    members,
    shares,
    partnerShares: shares.filter((s) => s.author_id !== userId).map((s) => s.content),
    myShares: shares.filter((s) => s.author_id === userId).map((s) => s.content),
  };
}

// ---------- Claude ----------

async function claude(env, system, messages, maxTokens = 600) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('No API key'), { publicMessage: 'The mediator is not set up yet (missing API key).' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw Object.assign(new Error(`Claude ${r.status}: ${t}`), { publicMessage: 'The mediator could not reply just now. Please try again.' });
  }
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Turn stored rows into alternating user/assistant turns.
function toTurns(rows, isUser) {
  const turns = [];
  for (const row of rows) {
    const role = isUser(row) ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${row.content}`;
    else turns.push({ role, content: row.content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

// ---------- Endpoints ----------

async function privateReply(env, jwt, ctx) {
  const rows = await db(env, jwt, `md_private_messages?session_id=eq.${ctx.sessionId}&select=role,content&order=id.asc`);
  const turns = toTurns(rows.slice(-60), (r) => r.role === 'user');
  if (!turns.length || turns[turns.length - 1].role !== 'user') return { ok: true, skipped: true };
  const reply = await claude(env, privatePrompt(ctx), turns);
  if (reply) await write(env, jwt, 'private', ctx.sessionId, reply);
  return { ok: true };
}

async function draftSummary(env, jwt, ctx) {
  const rows = await db(env, jwt, `md_private_messages?session_id=eq.${ctx.sessionId}&select=role,content&order=id.asc`);
  const mine = rows.filter((r) => r.role === 'user');
  if (!mine.length) return { error: 'Say a little in your private space first.' };
  const transcript = rows
    .slice(-80)
    .map((r) => `${r.role === 'user' ? ctx.me : 'Mediant'}: ${r.content}`)
    .join('\n\n');
  const draft = await claude(env, draftPrompt(ctx), [{ role: 'user', content: transcript }], 500);
  if (draft) await write(env, jwt, 'draft', ctx.sessionId, draft);
  return { ok: true, draft };
}

async function sharedReply(env, jwt, ctx) {
  const rows = await db(env, jwt, `md_shared_messages?session_id=eq.${ctx.sessionId}&select=author_id,role,content&order=id.asc`);
  const recent = rows.slice(-60);
  if (!recent.length || recent[recent.length - 1].role !== 'user') return { ok: true, skipped: true };
  const name = (id) => ctx.members.find((m) => m.user_id === id)?.display_name || 'Partner';
  const sharedNotes = ctx.shares.map((s) => `${name(s.author_id)} shared: ${s.content}`).join('\n\n');
  const thread = recent
    .map((r) => (r.role === 'mediator' ? `Mediant: ${r.content}` : r.role === 'system' ? `(${r.content})` : `${name(r.author_id)}: ${r.content}`))
    .join('\n\n');
  const prompt = `${sharedNotes ? `What each has chosen to share:\n${sharedNotes}\n\n` : ''}The shared conversation so far:\n\n${thread}\n\nReply as Mediant to the latest message.`;
  const reply = await claude(env, sharedPrompt({ topic: ctx.topic, names: ctx.members.map((m) => m.display_name) }), [
    { role: 'user', content: prompt },
  ]);
  if (reply) await write(env, jwt, 'shared', ctx.sessionId, reply);
  return { ok: true };
}
