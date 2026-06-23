# Deployment & Operations Runbook — Mega Mindikot 5v5

> **Read this first in any new session** — it's the source of truth for the
> production/staging servers, the day-to-day workflows, and the known box-specific
> caveats. Keep it updated whenever the deployment changes.

---

## 1. The servers (as of 2026-06-22)

| | Production | Staging (preview) |
|---|---|---|
| **URL** | `https://play.mindikot.com` | `https://staging.mindikot.com` |
| **Branch** | `live` | `staging` |
| **Box checkout** | `~/mega-mindikot` | `~/mega-mindikot-staging` |
| **Containers** | `mm-app` + `mm-db` | `mm-staging-app` + `mm-staging-db` |
| **Compose service** | `app` | `staging-app` |
| **Database** | `mm-db` / volume `pg_data` (real accounts) | `mm-staging-db` / volume `pg_data_staging` (throwaway) |
| **Purpose** | Real players | Pre-merge QA — eyeball every change here first |

**Both run on one OVHcloud VPS**, in a **single `docker-compose` stack** at
`~/mega-mindikot/deploy/docker-compose.yml`. They share Caddy (the only thing that
can hold ports 80/443), the `mm-net` Docker network, and the LiveKit SFU
(`mm-livekit`, reused by both apps — tokens are stateless). Everything else is
isolated: `staging-app` cannot reach prod's `db` or `pg_data`, and Caddy routes by
hostname so a staging deploy or crash never reaches `play.*`.

### Host details
- **Provider:** OVHcloud VPS-1 2027, Canada — Beauharnois (BHS)
- **Hostname:** `vps-38d48eec.vps.ovh.ca`
- **IP:** `158.69.49.43`
- **OS:** Debian 13
- **Spec:** 2 vCores / 4 GB RAM / 40 GB NVMe, automated backups on, Anti-DDoS included
- **SSH user:** `debian` (password auth — NOT the `mm` user the README Phase 2
  describes; that hardening step was never run)
- **Registrar / DNS:** Porkbun (`mindikot.com`); A records for `play`, `staging`,
  `voice`, `@` all point at the VPS IP, TTL 600, **DNS-only (no Cloudflare proxy)**
- **GitHub:** `github.com/AlphaStarX/mega-mindikot`

### Full container map
```
OVHcloud VPS (158.69.49.43) — single docker-compose stack at ~/mega-mindikot/deploy
├── Caddy  (80/443, auto Let's Encrypt TLS)
│     ├── play.mindikot.com    ─► app:3000          (prod, branch live)
│     ├── staging.mindikot.com ─► staging-app:3000  (preview, branch staging)
│     └── voice.mindikot.com   ─► livekit:7880      (WSS signaling, shared SFU)
├── app         (node :3000)  — prod game server   [~/mega-mindikot, branch live]
├── staging-app (node :3000)  — preview            [~/mega-mindikot-staging, branch staging]
├── db          (postgres:16) — prod accounts       [volume pg_data]
├── staging-db  (postgres:16) — throwaway accounts  [volume pg_data_staging]
└── livekit     (SFU + TURN)  — shared by both apps
        7880/tcp signaling (Caddy-fronted)
        5349/tcp+udp TURN/TLS, 50000-50100/udp WebRTC  — exposed DIRECTLY (not proxied)
```

> ⚠️ **Firewall/UFW range is `50000-50100` (101 ports), NOT `50000-60000`.** The
> repo's `deploy/docker-compose.yml` and `deploy/README.md` historically say
> `50000-60000`, but the live box and its UFW use the narrower `50000-50100`.
> See §5 "Known box-specific caveats" below.

---

## 2. Day-to-day workflows

### Ship a change to STAGING for QA
```bash
# --- on your laptop ---
git push origin staging

# --- on the box (ssh debian@158.69.49.43) ---
cd ~/mega-mindikot-staging && git pull
cd ~/mega-mindikot/deploy && docker compose up -d --build staging-app
```
Visible at `https://staging.mindikot.com` within ~30s of rebuild. **Prod is untouched.**

### Promote STAGING → PROD (after QA passes)
```bash
# --- on your laptop: merge staging into live and push ---
git checkout live
git merge --ff-only staging
git push origin live

# --- on the box ---
cd ~/mega-mindikot && git pull
cd deploy && docker compose up -d --build app
```

### Cherry-pick a shared-infra commit onto BOTH branches (rare)
Deploy-file changes (compose, Caddyfile) are shared by both branches. If you land
one on `staging` and need it on the box's prod checkout without merging app code:
```bash
git checkout live && git pull origin live
git cherry-pick <commit-sha>          # the deploy-infra commit only
git push origin live
git checkout staging
# then `git pull` in ~/mega-mindikot on the box
```

### Recreate Caddy after a Caddyfile / domain change
Caddy reads its config + `{$ENV}` vars at container start, so a Caddyfile or domain
change needs a recreate (not a restart). **Expect a ~3–5s blip on `play.*`** — pick a
quiet moment.
```bash
cd ~/mega-mindikot/deploy
docker compose up -d caddy
```

### Wipe staging's throwaway database (reset all staging accounts/data)
Prod is never affected.
```bash
cd ~/mega-mindikot/deploy
docker compose rm -sf staging-db
docker volume rm deploy_pg_data_staging      # prefix may differ; check `docker volume ls`
docker compose up -d --build staging-app     # staging-db recreates + re-migrates on boot
```

### View logs / status
```bash
cd ~/mega-mindikot/deploy
docker compose ps                           # all containers + health
docker compose logs app --tail=50           # prod app
docker compose logs staging-app --tail=50   # staging app
docker compose logs caddy --tail=30         # TLS/routing
```

---

## 3. DNS records (Porkbun, `mindikot.com`)

| Type | Host | Answer | TTL | Notes |
|---|---|---|---|---|
| `A` | `play` | `158.69.49.43` | 600 | prod game |
| `A` | `staging` | `158.69.49.43` | 600 | preview |
| `A` | `voice` | `158.69.49.43` | 600 | LiveKit signaling |
| `A` | `@` | `158.69.49.43` | 600 | apex, redirects to `play.*` |

All **DNS-only** — do NOT enable Cloudflare's orange-cloud proxy (it breaks WebRTC
UDP for voice). Caddy auto-issues/renews TLS certs for each.

---

## 4. Branch model

| Branch | Purpose |
|---|---|
| `main` | Original baseline, untouched since first commit |
| `live` | **Production** — what the box's `~/mega-mindikot` checkout runs |
| `staging` | **Active development + preview** — what `~/mega-mindikot-staging` runs |

Promotion: develop on `staging` → `npm test` → QA on staging URL → merge to `live` →
push → redeploy prod. The box's prod checkout clones/pulls `-b live`.

> **Ground rule:** never `git push` without explicit user permission, and treat
> `live`/`main` as doubly protected.

---

## 5. Known box-specific caveats (LOCAL EDITS — don't clobber on pull)

These are local edits on the box's `~/mega-mindikot` checkout that are NOT in the
repo. A blind `git pull` will refuse to overwrite them (good), but they're easy to
lose if someone force-checks-out. If the repo and box ever drift, these are why.

1. **`deploy/docker-compose.yml` — staging build-context path.** Repo says
   `../mega-mindikot-staging`; the box needs `../../mega-mindikot-staging` (the
   compose file lives in `deploy/`, so `..` is `~/mega-mindikot/`, one level too
   low). **The box's local value is the correct one.**
2. **`deploy/docker-compose.yml` — LiveKit UDP range.** Repo says
   `50000-60000`; the box (and its UFW rules) use `50000-50100` (101 ports).
   **The box's local value is the correct one** — matches the firewall.
3. **`deploy/livekit.yaml` — real secrets.** The box has the real
   `LIVEKIT_API_KEY`/`SECRET` and `turn.domain: voice.mindikot.com`. The repo file
   has placeholders.

**The clean fix for all three:** commit the box's correct values into the repo
(compose path fix, `50000-50100`, and keep `livekit.yaml` as template-only with a
documented "fill on box" step). Until then, **`git pull` on the box will require
the stash → pull → stash-pop dance** when the touched files change upstream. See §6.

---

## 6. The stash-pull-pop dance (when `git pull` refuses)

If `git pull` on `~/mega-mindikot` errors with *"Your local changes to the
following files would be overwritten by merge"*, that's git protecting the §5 local
edits. Resolve it safely:

```bash
cd ~/mega-mindikot
git stash push -m "prod local config: staging path + UDP range + livekit secrets"
git pull
git stash pop          # auto-merges; if it conflicts, resolve by keeping BOTH
grep "50000" deploy/docker-compose.yml      # VERIFY the UDP range survived
grep "mega-mindikot-staging" deploy/docker-compose.yml   # VERIFY path survived
```

If `git stash pop` reports a merge conflict, **don't panic, don't force-resolve** —
open the file, keep the box's correct values (see §5), save, and `git add` the
resolved file. The staging services live in a different section of the file so they
won't collide.

---

## 7. Environment variables (`.env` on the box, `~/mega-mindikot/deploy/.env`)

| Variable | Purpose |
|---|---|
| `PLAY_DOMAIN` / `VOICE_DOMAIN` / `STAGING_DOMAIN` | Hostnames Caddy obtains certs for |
| `PUBLIC_IP` (`158.69.49.43`) | Passed to LiveKit as `--node-ip` |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | Postgres creds (both prod + staging db use same creds, separate containers/volumes) |
| `JWT_SECRET` | HS256 session signing (shared by prod + staging) |
| `LIVEKIT_API_KEY` / `_SECRET` / `_URL` | SFU token minting (shared by both apps) |
| `STAGING_DEBUG_KEY` (optional) | If set, debug panel on staging at `?debug=1&key=...` |
| `DEBUG_KEY` (optional) | Same for prod |

The compose file composes `DATABASE_URL` from the `POSTGRES_*` vars; it's not set
directly. Generate secrets with `openssl rand -base64 32` (or `openssl rand -hex 16`
for the debug key).

---

## 8. First-time bring-up (reference — already done)

For a fresh VPS, follow `deploy/README.md` Phases 0–10. The staging environment
specifically (Phase 10) was brought up on 2026-06-22:
1. Added `staging` DNS A record at Porkbun.
2. Cloned `~/mega-mindikot-staging`, `git checkout staging`.
3. Added `STAGING_DOMAIN=staging.mindikot.com` to `.env`.
4. `docker compose up -d --build staging-app` (built + started `staging-db` + `staging-app`).
5. `docker compose up -d caddy` (recreated Caddy to pick up the staging site block
   + env var; ~5s prod blip; Let's Encrypt cert issued for `staging.*` in ~3s).

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `git pull` refuses (local changes) | §6 stash-pull-pop dance |
| Can't SSH / permission denied | You're probably using the wrong user — it's `debian`, not `mm` or `root`. Password auth. |
| `staging.mindikot.com` won't resolve | DNS not propagated — wait, then `nslookup staging.mindikot.com` |
| TLS error on first hit | Caddy needs ~30s to issue the cert; retry. `docker compose logs caddy` |
| `staging-app` restart loop | `docker compose logs staging-app` — usually a build or migration error |
| Build context path error | You're on the repo's wrong path; the box uses `../../mega-mindikot-staging` (§5) |
| Voice one-way / choppy | Check UFW allows `50000-50100/udp` + `5349/tcp+udp`; matches compose |
| `play.*` down after Caddy recreate | Shouldn't persist >10s; check `docker compose ps`, then `docker compose up -d caddy` again |

---

## 10. Definition of "staging is working"

- `https://staging.mindikot.com` loads, valid TLS, serves the `staging` branch.
- Signup/login/reconnect work against `staging-db`; prod accounts on `play.*` unaffected.
- A `staging` commit → `git pull` + `--build staging-app` → visible at the staging URL within ~30s.
- `https://play.mindikot.com` continues serving `live`, untouched by staging deploys.
