# Deploying Mega Mendikot 5v5 on OVHcloud (Montreal)

This is the **step-by-step runbook** for hosting the game + team voice (LiveKit) on a
single OVHcloud VPS in Montreal, with automatic TLS via Caddy. Scope: **app + voice
first** — Postgres/login is a later step (see "Next phase" at the bottom).

> Target host: **OVHcloud VPS-1** (2 vCore / 4 GB / 40 GB NVMe, ~$7.60 CAD/mo),
> region **Canada (Beauharnois/Montreal)**, **Debian 12**. Everything here runs as root
> unless noted; switch to a non-root user in Phase 3.

---

## Architecture on the box

```
OVH Montreal VPS (Debian 12)
├── Caddy  (ports 80/443, automatic Let's Encrypt TLS)
│     ├── play.<domain>   ─► app:3000          (HTTP + /ws WebSocket)
│     └── voice.<domain>  ─► livekit:7880      (WSS signaling only)
├── app: node server/index.js :3000            (the zero-dependency game)
└── livekit: SFU + embedded TURN
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

## Phase 1 — Provision the OVH VPS

1. Sign in at **ovhcloud.com/en-ca** → **VPS** → order **VPS v1** (2 vCore / 4 GB).
2. Choose:
   - **Region: Canada** (Beauharnois / Montreal — lowest latency for Canadian players)
   - **OS: Debian 12 (Bookworm)**
   - **Billing: monthly**
3. At checkout, add your **SSH public key** if you have one (recommended). Otherwise OVH
   emails a root password.
4. Wait for provisioning (~1–3 min). In the OVH dashboard, copy the **public IPv4**
   (looks like `51.79.x.x` or `192.99.x.x`).

## Phase 2 — Point your domain at the VPS

5. At your registrar (Cloudflare, Namecheap, GoDaddy, etc.), add **two A records**:
   | Host | Type | Value |
   |---|---|---|
   | `play` | A | `<vps-ip>` |
   | `voice` | A | `<vps-ip>` |
   - Tip: set TTL to 5 min during setup; raise to 1h after it's working.
   - If using Cloudflare, set these records to **DNS-only (grey cloud)** for `voice.*`
     — Cloudflare's proxy doesn't forward WebRTC UDP. `play.*` can be proxied (orange).
6. Wait for propagation, then verify from your own machine:
   ```bash
   nslookup play.your-domain.com
   nslookup voice.your-domain.com
   # both should resolve to your VPS IP
   ```

## Phase 3 — First login + harden the box

7. SSH in:
   ```bash
   ssh root@<vps-ip>
   ```
8. Update the system:
   ```bash
   apt update && apt upgrade -y
   ```
9. Install Docker (includes the compose plugin):
   ```bash
   curl -fsSL https://get.docker.com | sh
   docker --version && docker compose version   # sanity check
   ```
10. (Recommended) Create a non-root admin user and add it to docker:
    ```bash
    adduser mm
    usermod -aG docker mm
    mkdir -p /home/mm/.ssh && cp ~/.ssh/authorized_keys /home/mm/.ssh/ && \
      chown -R mm:mm /home/mm/.ssh
    ```
11. Lock down SSH — edit `/etc/ssh/sshd_config`:
    ```
    PermitRootLogin no            # once you've confirmed mm can log in
    PasswordAuthentication no     # key-only
    ```
    Then `systemctl restart ssh`. **Test `ssh mm@<vps-ip>` in a second terminal
    before closing your root session.**

## Phase 4 — Open firewall ports

12. Configure UFW (Debian may need it installed first: `apt install -y ufw`):
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
    > OVH also has its own security group / firewall in the dashboard ("VPS firewall"
    > under Network). If you enabled it, mirror these rules there too.

## Phase 5 — Get the code onto the box

13. As user `mm`, clone the repo:
    ```bash
    cd ~
    git clone https://github.com/<you>/MegaMendiCoat.git
    cd MegaMendiCoat/deploy
    ```
    (Or `scp -r deploy/ mm@<vps-ip>:~/MegaMendiCoat/` if you prefer not to clone.)

## Phase 6 — Configure secrets

14. Generate a strong LiveKit secret and a short API key:
    ```bash
    openssl rand -base64 32     # → this is LIVEKIT_API_SECRET
    openssl rand -hex 8         # → use as LIVEKIT_API_KEY (or pick e.g. APIxxxxxxxxxxxxx)
    ```
15. Create the env file from the template:
    ```bash
    cp .env.example .env
    nano .env     # fill in the four REAL values below
    ```
    ```ini
    PLAY_DOMAIN=play.your-domain.com
    VOICE_DOMAIN=voice.your-domain.com
    PUBLIC_IP=<vps-ip>
    LIVEKIT_API_KEY=<the key from step 14>
    LIVEKIT_API_SECRET=<the secret from step 14>
    LIVEKIT_URL=wss://voice.your-domain.com
    ```
16. Put the **same** `key` + `secret` into `livekit.yaml`, and your real voice domain:
    ```bash
    nano livekit.yaml
    # set: key, secret, and turn.domain  (match .env exactly)
    ```
    > The app signs voice tokens with this secret; the SFU verifies them. A mismatch
    > is the #1 cause of "voice won't connect" — double-check they're identical.

## Phase 7 — TURN/TLS certificate (port 5349)

TURN/TLS needs a real cert for `voice.<domain>`. Two options:

17. **Option A — let Caddy obtain it, then point LiveKit at it.** Simplest path:
    - Start the stack (Phase 8) **once** so Caddy fetches a cert for `voice.<domain>`.
    - Caddy stores certs under its data volume. Symlink or copy the `voice.*` cert+key
      into `./certs/turn.crt` and `./certs/turn.key`, then `docker compose restart livekit`.
    - (Caddy's on-disk cert paths are keyed by hostname under the `caddy_data` volume.)

18. **Option B — issue a standalone cert with certbot** (cleaner, independent of Caddy):
    ```bash
    apt install -y certbot
    certbot certonly --standalone -d voice.your-domain.com
    # Stop Caddy first if it's already holding port 80 during issuance.
    cp /etc/letsencrypt/live/voice.your-domain.com/fullchain.pem ~/MegaMendiCoat/deploy/certs/turn.crt
    cp /etc/letsencrypt/live/voice.your-domain.com/privkey.pem   ~/MegaMendiCoat/deploy/certs/turn.key
    ```
    Then set up renewal (certbot installs a systemd timer by default). On renewal, copy
    the files again — or use `--deploy-hook` to automate the copy + `docker compose restart livekit`.

> If you skip this, LiveKit generates a self-signed TURN cert. **Most browsers reject
> TURN/TLS with self-signed certs**, so voice may fail on strict-NAT networks. Don't
> skip it for production.

## Phase 8 — Bring it up

19. From the `deploy/` directory:
    ```bash
    docker compose up -d --build
    docker compose ps             # all three services: running
    docker compose logs -f        # tail logs (Ctrl-C to exit, services keep running)
    ```
20. Confirm each piece:
    - **App:** `curl -k https://localhost/health` → `ok` (after Caddy has a cert),
      or `curl http://localhost:3000/` from the host.
    - **LiveKit signaling:** `curl http://localhost:7880` → a LiveKit response (not connection refused).
    - **Caddy cert:** the first request to `https://play.<domain>` triggers issuance; check
      `docker compose logs caddy` for "certificate obtained successfully".

## Phase 9 — Verify end-to-end

21. **Game loads:** open `https://play.your-domain.com` → you should see the join screen,
    valid padlock (TLS works).
22. **A match runs:** Quick Match → a game starts, cards play, bots work.
23. **Voice works (same team):**
    - Open a **private room**, copy the share link.
    - Open the link in **two browser tabs** (or two devices) on the same network.
    - Join both as humans; they'll be placed to balance teams. If they end up on different
      teams, create two private rooms or use 5 tabs to force same-team seating.
    - Start the match. Both tabs should show the 🎙️ mic button; grant mic permission.
    - Speak → you should hear each other.
24. **Voice is isolated (opposing team):** join a third tab on the opposing team → it must
    **NOT** hear the first team's audio.
25. **TURN/NAT path:** connect one client from a **mobile hotspot** (different NAT). If voice
    still connects, TURN is doing its job.

## Phase 10 — Ongoing operations

```bash
docker compose logs -f                    # follow all logs
docker compose logs -f app                # just the game
docker compose restart app                # restart the game (no rebuild)
docker compose up -d --build app          # rebuild app after a code change

# Deploy an app update:
cd ~/MegaMendiCoat
git pull
cd deploy && docker compose up -d --build app

# Full teardown (keeps volumes/certs):
docker compose down
```

- **TLS renewals:** automatic (Caddy handles Let's Encrypt; certbot handles TURN cert).
- **Backups:** enable OVH's automated VPS snapshot (dashboard → your VPS → Backups). It's
  worth the small add-on fee once you have real players.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `https://play.*` won't load / cert error | DNS not propagated, or port 80/443 blocked | Verify A records; check `ufw status`; check OVH VPS firewall |
| Game loads, no 🎙️ button | App didn't get a voice token | Confirm `.env` has all three `LIVEKIT_*` vars and matches `livekit.yaml`; check `docker compose logs app` for "LiveKit" |
| 🎙️ shows, but voice never connects | SFU unreachable, or secret mismatch | `curl http://localhost:7880` should respond; compare `key`/`secret` in `.env` vs `livekit.yaml` char-for-char |
| Voice connects on same network, fails on mobile | TURN not working (cert/port) | Confirm `5349` and `50000-60000/udp` open in UFW **and** OVH firewall; confirm TURN cert is valid (not self-signed) |
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

- **Postgres + Prisma** — add a `db` service to `docker-compose.yml`, set `DATABASE_URL`,
  wire up the pending 🔶 persistence layer. The OVH VPS-1's 4 GB RAM fits Postgres fine.
- **Login/auth** — replace the anonymous `sessionId` with a real token; the LiveKit token
  issuance in `server/livekit.js` already keys off the seat/session, so it extends cleanly.
- **Scaling** — when you outgrow one box: keep app+DB here, move LiveKit to a dedicated
  instance; the `mm_{roomId}_{team}` topology is host-agnostic and needs no code change.
