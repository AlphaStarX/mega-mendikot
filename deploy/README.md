# Deploying Mega Mindikot 5v5 on OVHcloud

This is the **step-by-step runbook** for hosting the game + team voice (LiveKit) on a
single OVHcloud VPS, with automatic TLS via Caddy. Scope: **app + voice + accounts**
— Postgres/login is included (see "Next phase" at the bottom for stats/OAuth/etc.).

> **Domain:** `mindikot.com` (registered at Porkbun). Hostnames:
> `play.mindikot.com` (game) and `voice.mindikot.com` (LiveKit SFU).
>
> Target host: **OVHcloud VPS-1 2027** — 2 vCores / 4 GB RAM / 40 GB NVMe,
> **unlimited traffic**, **~1 Gbps** public port, **~$3.50–5/mo**.
> Region **Canada (Beauharnois, QC — `BHS`)** — the Toronto-area latency the project was
> designed around. OS **Debian 13**. OVH **Anti-DDoS** protection is included.
> Everything here runs as root unless noted; switch to a non-root user in Phase 2.

---

## Architecture on the box

```
OVHcloud VPS — Canada BHS / Beauharnois (Debian 13)
├── Caddy  (ports 80/443, automatic Let's Encrypt TLS)
│     ├── play.<domain>    ─► app:3000          (HTTP + /ws WebSocket)
│     ├── staging.<domain> ─► staging-app:3000  (staging preview, separate DB)
│     └── voice.<domain>   ─► livekit:7880      (WSS signaling only)
├── app: node server/index.js :3000            (prod game server)
├── staging-app: node server/index.js :3000    (staging preview)
├── db: postgres:16                            (prod accounts)
├── staging-db: postgres:16                    (throwaway staging accounts)
└── livekit: SFU + embedded TURN               (shared by app + staging-app)
        7880  TCP   signaling (fronted by Caddy)
        5349  TCP+UDP  TURN/TLS        ─┐
        50000-60000 UDP  WebRTC media  ─┴─ exposed DIRECTLY (not proxied)
```

**Key gotcha (from LiveKit docs):** WebRTC media and TURN/TLS **cannot** be
reverse-proxied through Caddy. Caddy terminates TLS only for the app and the
LiveKit *signaling* endpoint. The browser learns the UDP/TURN ports from the SFU
and connects to them directly. This is why `5349` and `50000-60000/udp` are
published on the livekit container, not on caddy.

---

## Phase 0 — Buy the domain & set up DNS (do this while the VPS provisions)

**Registrar:** Porkbun (`porkbun.com`) — `.com` at near-wholesale, no renewal markup,
free WHOIS privacy, free DNS. `mindikot.com` is **available** as of this writing.

1. Sign up at **porkbun.com** (email + password).
2. Search **`mindikot`** → add `mindikot.com` (~$10–11/yr) to cart → checkout.
3. At checkout, set:
   - **WHOIS Privacy:** ✅ ON (free, hides your personal info)
   - **Auto-renew:** ✅ ON (so it doesn't expire)
   - **Premium DNS:** ❌ OFF · **SSL:** ❌ OFF (Caddy handles certs)
4. Pay. The domain is active within a minute.

**Nameservers:** A fresh Porkbun domain uses Porkbun's nameservers by default, so
there's usually nothing to change. Verify in Domain Management → `mindikot.com` →
**Nameservers** that it says "Use Porkbun nameservers".

**Add three A records** (Domain Management → `mindikot.com` → **DNS** → "Add Record"):

| Type | Host | Answer | TTL |
|---|---|---|---|
| `A` | `play` | `<YOUR_VPS_IP>` | 600 |
| `A` | `voice` | `<YOUR_VPS_IP>` | 600 |
| `A` | `staging` | `<YOUR_VPS_IP>` | 600 |
| `A` | `@` | `<YOUR_VPS_IP>` | 600 |

The `@` record points the bare/apex domain (`mindikot.com`) at the VPS; Caddy
redirects it to `https://play.mindikot.com`. (Optional: add a matching `www`
record and a `www.mindikot.com` redirect block if you want `www` to work too.)
Both `play.*` and `voice.*` point at the same single VPS.

**Verify propagation** from your local machine (wait 2–10 min):
```bash
nslookup play.mindikot.com   # → your VPS IP
nslookup voice.mindikot.com  # → your VPS IP
```
Porkbun DNS is usually live within 5 minutes. Until both resolve to your VPS IP,
Caddy can't obtain TLS certs (Phases 6–7 will fail on cert issuance), so don't skip
this check.

> ⚠️ **Do not use Cloudflare's orange-cloud proxy on the `voice` record.** Cloudflare's
> proxy only forwards HTTP(S), not WebRTC UDP, so it breaks voice. Leave both records
> DNS-only (Porkbun is DNS-only by default, so this is automatic).

---

## Phase 1 — Provision the OVHcloud VPS

1. Sign up at **[ovhcloud.com](https://www.ovhcloud.com)** (or `ovh.ca` for Canada).
   You must **add a payment method** to verify the account. New VPS orders can take a
   few minutes to a couple of hours to activate while OVH verifies the account — this
   is normal; you'll get an activation email.
2. Order a **VPS-1 2027**: **OVHcloud → Bare Metal Cloud → VPS → Your VPS**. Choose:
   - **Model:** **VPS-1 2027** — 2 vCores / 4 GB RAM / 40 GB NVMe, unlimited traffic,
     ~1 Gbps port. Enough for the game + Postgres + LiveKit + Caddy at launch scale.
   - **Distribution/OS:** **Debian 13**.
   - **Datacenter:** **Canada — Beauharnois (`BHS`)** — lowest latency for the
     North-American player base the project targets.
   - **Login:** **SSH Key** (strongly recommended). If you don't have one yet, generate
     it locally with `ssh-keygen -t ed25519` and paste the contents of
     `~/.ssh/id_ed25519.pub` into the order form. Alternatively, OVH sets a root
     **password** and emails it to you — but switch to key-only auth in Phase 2 either way.
   - **Add-ons:** OVH includes **Anti-DDoS** at the network edge for free. Daily backup
     of the previous 24h may be included/bundled — check the order summary. Extra
     automated backups are a low-cost add-on if you want longer retention.
3. Complete checkout. Wait for the activation email ("Your VPS has been delivered").
4. Copy the VPS's **public IPv4** from **OVHcloud Control Panel → Bare Metal Cloud →
   Your services → your VPS → `IP`** (looks like `149.56.x.x`, `192.99.x.x`,
   `158.69.x.x`, or `51.79.x.x` for BHS).

> **Upgrading later:** OVH lets you change VPS models in-place from the control panel
> (e.g. VPS-1 → VPS-2 → VPS-3). Resizing to a bigger plan keeps your data but **changes
> your public IP** (requires DNS re-pointing + a Caddy cert re-issue), so size generously
> upfront if you expect fast growth.

## Phase 2 — First login + harden the box

5. SSH in. If you used a password, OVH emails it to you:
   ```bash
   ssh root@<your-ip>      # then enter the emailed password
   ```
   If you uploaded an SSH key at order time, it authenticates by key instead.
6. Update the system:
   ```bash
   apt update && apt upgrade -y
   ```
7. Install Docker (includes the compose plugin):
   ```bash
   curl -fsSL https://get.docker.com | sh
   docker --version && docker compose version   # sanity check
   ```
8. (Recommended) Create a non-root admin user and add it to docker:
   ```bash
   adduser mm
   usermod -aG docker mm
   mkdir -p /home/mm/.ssh && cp ~/.ssh/authorized_keys /home/mm/.ssh/ && \
     chown -R mm:mm /home/mm/.ssh
   ```
9. Lock down SSH — edit `/etc/ssh/sshd_config`:
   ```
   PermitRootLogin no            # once you've confirmed mm can log in
   PasswordAuthentication no     # key-only
   ```
   Then `systemctl restart ssh`. **Test `ssh mm@<vps-ip>` in a second terminal
   before closing your root session.**

## Phase 3 — Open firewall ports

OVH has two network layers to be aware of. **Always configure the host firewall (UFW)**.
OVH also offers a separate **Network Security / Firewall** in the control panel — leave
it at its default unless you deliberately want a second layer.

**A. Host-level firewall (UFW) — always do this** (Debian may need it installed first:
`apt install -y ufw`):
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp                 # SSH (consider: ufw allow from <your-ip> to any port 22)
ufw allow 80/tcp                 # Caddy HTTP (ACME challenge + redirect)
ufw allow 443/tcp                # Caddy HTTPS
ufw allow 443/udp                # HTTP/3 (optional)
ufw allow 5349/tcp               # TURN/TLS
ufw allow 5349/udp               # TURN/UDP
ufw allow 50000:60000/udp        # WebRTC media range
ufw --force enable
ufw status verbose
```

**B. OVH network firewall — optional.** OVH's in-control-panel firewall (Network
Security) is **off by default**, and OVH's **Anti-DDoS** layer runs in front of it
regardless (always on, free). You can enable the explicit network firewall for
defense-in-depth if you want, but it's not required — UFW handles the job. If you ever
**do** enable it, remember it sits **in front of** UFW and blocks traffic UFW allows —
so you MUST replicate every inbound rule there (especially the UDP `50000-60000` media
range and `5349`), or voice will silently fail. Also note OVH's network firewall only
filters **ingress**, not egress.

## Phase 4 — Get the code onto the box

10. As user `mm`, clone the repo:
    ```bash
    cd ~
    git clone https://github.com/AlphaStarX/mega-mindikot.git
    cd mega-mindikot/deploy
    ```
    (Or `scp -r deploy/ mm@<vps-ip>:~/mega-mindikot/` if you prefer not to clone.)

## Phase 5 — Configure secrets

11. Generate a strong LiveKit secret and a short API key:
    ```bash
    openssl rand -base64 32     # → this is LIVEKIT_API_SECRET
    openssl rand -hex 8         # → use as LIVEKIT_API_KEY (or pick e.g. APIxxxxxxxxxxxxx)
    ```
12. Create the env file from the template:
    ```bash
    cp .env.example .env
    nano .env     # fill in the four REAL values below
    ```
    ```ini
PLAY_DOMAIN=play.mindikot.com
VOICE_DOMAIN=voice.mindikot.com
STAGING_DOMAIN=staging.mindikot.com
PUBLIC_IP=<vps-ip>
LIVEKIT_API_KEY=<the key from step 11>
LIVEKIT_API_SECRET=<the secret from step 11>
LIVEKIT_URL=wss://voice.mindikot.com
```
13. Put the **same** `key` + `secret` into `livekit.yaml`, and your real voice domain:
    ```bash
    nano livekit.yaml
    # set: key, secret, and turn.domain  (match .env exactly)
    ```
    > The app signs voice tokens with this secret; the SFU verifies them. A mismatch
    > is the #1 cause of "voice won't connect" — double-check they're identical.

## Phase 6 — TURN/TLS certificate (port 5349)

TURN/TLS needs a real cert for `voice.<domain>`. Two options:

14. **Option A — let Caddy obtain it, then point LiveKit at it.** Simplest path:
    - Start the stack (Phase 8) **once** so Caddy fetches a cert for `voice.<domain>`.
    - Caddy stores certs under its data volume. Symlink or copy the `voice.*` cert+key
      into `./certs/turn.crt` and `./certs/turn.key`, then `docker compose restart livekit`.
    - (Caddy's on-disk cert paths are keyed by hostname under the `caddy_data` volume.)

15. **Option B — issue a standalone cert with certbot** (cleaner, independent of Caddy):
    ```bash
    apt install -y certbot
    certbot certonly --standalone -d voice.mindikot.com
    # Stop Caddy first if it's already holding port 80 during issuance.
    cp /etc/letsencrypt/live/voice.mindikot.com/fullchain.pem ~/mega-mindikot/deploy/certs/turn.crt
    cp /etc/letsencrypt/live/voice.mindikot.com/privkey.pem   ~/mega-mindikot/deploy/certs/turn.key
    ```
    Then set up renewal (certbot installs a systemd timer by default). On renewal, copy
    the files again — or use `--deploy-hook` to automate the copy + `docker compose restart livekit`.

> If you skip this, LiveKit generates a self-signed TURN cert. **Most browsers reject
> TURN/TLS with self-signed certs**, so voice may fail on strict-NAT networks. Don't
> skip it for production.

## Phase 7 — Bring it up

16. From the `deploy/` directory:
    ```bash
    docker compose up -d --build
    docker compose ps             # all three services: running
    docker compose logs -f        # tail logs (Ctrl-C to exit, services keep running)
    ```
17. Confirm each piece:
    - **App:** `curl -k https://localhost/health` → `ok` (after Caddy has a cert),
      or `curl http://localhost:3000/` from the host.
    - **LiveKit signaling:** `curl http://localhost:7880` → a LiveKit response (not connection refused).
    - **Caddy cert:** the first request to `https://play.<domain>` triggers issuance; check
      `docker compose logs caddy` for "certificate obtained successfully".

## Phase 8 — Verify end-to-end

18. **Game loads:** open `https://play.mindikot.com` → you should see the join screen,
    valid padlock (TLS works).
19. **A match runs:** Quick Match → a game starts, cards play, bots work.
20. **Voice works (same team):**
    - Open a **private room**, copy the share link.
    - Open the link in **two browser tabs** (or two devices) on the same network.
    - Join both as humans; they'll be placed to balance teams. If they end up on different
      teams, create two private rooms or use 5 tabs to force same-team seating.
    - Start the match. Both tabs should show the 🎙️ mic button; grant mic permission.
    - Speak → you should hear each other.
21. **Voice is isolated (opposing team):** join a third tab on the opposing team → it must
    **NOT** hear the first team's audio.
22. **TURN/NAT path:** connect one client from a **mobile hotspot** (different NAT). If voice
    still connects, TURN is doing its job.

## Phase 9 — Ongoing operations

```bash
docker compose logs -f                    # follow all logs
docker compose logs -f app                # just the game
docker compose restart app                # restart the game (no rebuild)
docker compose up -d --build app          # rebuild app after a code change

# Deploy an app update:
cd ~/mega-mindikot
git pull
cd deploy && docker compose up -d --build app

# Full teardown (keeps volumes/certs):
docker compose down
```

- **TLS renewals:** automatic (Caddy handles Let's Encrypt; certbot handles TURN cert).
- **Backups:** OVH includes a **daily backup of the previous 24h** (check your plan's
  inclusions). For longer retention, enable OVH's automated backups add-on in the
  control panel. Worth it once you have real players.

---

## Phase 10 — Staging environment (`staging.mindikot.com`)

A permanent, always-on preview of the **`staging` branch**, isolated from production
(`play.mindikot.com` → branch `live`). Use it to eyeball every change in a browser
before merging to `live`. Staging runs **guest + accounts** against its **own throwaway
Postgres** (separate container + volume), so signup/login/reconnect and DB-migration
flows can be exercised without ever touching production accounts. Voice reuses prod's
shared LiveKit SFU (tokens are stateless).

**Layout on the box — two checkouts:**

| Checkout | Branch | Build context for | Reached at |
|---|---|---|---|
| `~/mega-mindikot` | `live` | `app` (prod) | `play.mindikot.com` |
| `~/mega-mindikot-staging` | `staging` | `staging-app` (preview) | `staging.mindikot.com` |

Both live in a **single `docker-compose` stack** — they share Caddy (the only thing
that can hold 80/443), the `mm-net` network, and the LiveKit SFU, but are otherwise
fully isolated: `staging-app` cannot reach prod's `db` service or `pg_data` volume,
and Caddy routes by hostname so a staging deploy or crash never reaches `play.*`.

**Prerequisite:** a `staging` A record pointing at the VPS (added in Phase 0 above).
Caddy auto-issues a cert for `staging.mindikot.com` on first request.

### First-time setup (once the stack is already running)

1. Clone a second checkout and switch it to `staging`:
   ```bash
   cd ~
   git clone https://github.com/AlphaStarX/mega-mindikot.git mega-mindikot-staging
   cd mega-mindikot-staging && git checkout staging
   ```
2. Make sure `~/mega-mindikot/deploy/.env` has `STAGING_DOMAIN=staging.mindikot.com`
   (the `.env.example` template includes it). Optionally set `STAGING_DEBUG_KEY` to
   arm the debug panel behind `?debug=1&key=...`.
3. Bring up the staging services from the **prod** checkout's `deploy/` dir (that's
   where the shared stack lives):
   ```bash
   cd ~/mega-mindikot/deploy
   docker compose up -d --build staging-app
   docker compose ps        # staging-app + staging-db: running
   ```
4. Open `https://staging.mindikot.com` → you should see the `staging` branch, valid TLS.

### Deploy an update to staging (after a code change on the `staging` branch)

```bash
cd ~/mega-mindikot-staging && git pull
cd ~/mega-mindikot/deploy && docker compose up -d --build staging-app
```
Visible at the staging URL within ~30s of rebuild. **Prod (`play.*`) is not touched.**

### Deploy an update to prod (the existing flow, unchanged)

```bash
cd ~/mega-mindikot && git pull          # pull the change (now on `live`)
cd deploy && docker compose up -d --build app
```

### Wipe staging accounts (reset the throwaway database)

```bash
cd ~/mega-mindikot/deploy
docker compose rm -sf staging-db
docker volume rm deploy_pg_data_staging      # adjust the `deploy_` prefix to your compose project name
docker compose up -d --build staging-app     # staging-db recreates + re-runs migrations on boot
```
This destroys only staging's data — prod's `db` / `pg_data` are untouched.

### Resource cost

- +1 Node container (~60 MB) + +1 Postgres (~120 MB) ≈ **~180 MB extra RAM** at peak.
- Comfortable on the 4 GB VPS-1 at launch scale; if concurrency grows, revisit.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `https://play.*` won't load / cert error | DNS not propagated, or port 80/443 blocked | Verify A records; check `ufw status`; if you enabled the OVH network firewall, check its rules too |
| Game loads, no 🎙️ button | App didn't get a voice token | Confirm `.env` has all three `LIVEKIT_*` vars and matches `livekit.yaml`; check `docker compose logs app` for "LiveKit" |
| 🎙️ shows, but voice never connects | SFU unreachable, or secret mismatch | `curl http://localhost:7880` should respond; compare `key`/`secret` in `.env` vs `livekit.yaml` char-for-char |
| Voice connects on same network, fails on mobile | TURN not working (cert/port) | Confirm `5349` and `50000-60000/udp` open in UFW **and** the OVH network firewall (if enabled); confirm TURN cert is valid (not self-signed) |
| Voice quality degrades / throttle under load | OVH fair-use bandwidth restriction | OVH may throttle "abnormal" traffic to 1 Mbps; a heavy voice relay can trip this. If it recurs, consider scaling up the VPS or moving LiveKit to a dedicated box. |
| Opponents can hear each other | Should be impossible (structural isolation) | Check that each team's LiveKit room name differs: `mm_<roomId>_A` vs `mm_<roomId>_B`. If identical, the server isn't reading seat.team correctly. |
| `docker compose up` errors on UDP range | Some Docker versions dislike 10000-port UDP ranges | Narrow `port_range_end` in livekit.yaml + compose to e.g. `50000-50100` (1 port per concurrent participant needed) |

---

## Files in this folder

| File | Purpose |
|---|---|
| `docker-compose.yml` | The three-service stack (app + livekit + caddy) |
| `Caddyfile` | TLS termination + reverse proxy (hostnames from env) |
| `livekit.yaml` | LiveKit SFU + TURN config (secrets must match `.env`) |
| `.env.example` | Template — copy to `.env` and fill in |
| `README.md` | This runbook |

Plus, in the repo root: `Dockerfile` (containerizes the zero-dep app) and `.dockerignore`.

---

## Next phase (not in this pass)

- **Stats & match history** — already have the DB foundation; add columns to `User` written
  at match end. The VPS's 4 GB RAM fits Postgres comfortably.
- **OAuth (Google/GitHub)** — layered on the existing JWT account system.
- **Scaling** — when you outgrow one box: keep app+DB here, move LiveKit to a dedicated
  instance (or upgrade to a larger OVH VPS plan); the `mm_{roomId}_{team}` topology is
  host-agnostic.
