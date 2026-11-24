# Mediant

Private prototype. Two people each talk to a mediator on their own, approve what gets shared, then talk together with the mediator pacing the conversation.

## How it fits together

- `public/` – the web app (plain HTML/JS, Supabase JS from a CDN).
- `src/worker.js` – Cloudflare Worker. Serves `public/` and runs the mediator at `/api/private`, `/api/draft`, `/api/shared`.
- `src/prompts.js` – the mediator's instructions, including safeguarding.
- Database: `md_*` tables in the learn-spanish Supabase project, protected by row-level security. Schema is in that project's migration history (`mediant_init`, `mediant_worker_writes`).

## Privacy model

- Private messages and drafts: readable only by their author.
- Shares and the shared thread: readable by the two members of that session only.
- The Worker acts with the signed-in person's own token, so it can only read what they can.
- Mediator messages are written through `md_worker_write`, which needs `MEDIANT_WORKER_KEY` (only its SHA-256 is stored in the database).
- Sign-in is limited to emails in `md_allowed_emails` (managed in the app by an admin).

## Setup

Cloudflare Worker `mediant`, connected to this repo. Secrets:

| Name | What |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key |
| `MEDIANT_WORKER_KEY` | Worker write key |

Supabase → Authentication → URL Configuration: add the Worker URL to Redirect URLs so email links work.
