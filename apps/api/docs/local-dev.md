# Local development topology

What's running where, and why.

## Two modes

### Laptop-only mode

Browser → mobile bundler → backend → DDB/MinIO. All on `localhost`. **3 things to start**:

```bash
# In gdp-backend:
npm run dev          # docker compose up + bootstrap + tsx watch (1 process tree)
# In gdp-mobile:
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000 npm run web
```

That's it. Open `http://localhost:8081` in your laptop browser. Dev sign-in works (auth-bypass mode is on locally), `/healthz`, the works.

### iPhone-testing mode

Browser on your **iPhone** → cloudflared HTTPS tunnel → mobile bundler → cloudflared tunnel → backend → cloudflared tunnel → MinIO. **5 things to start**:

| Process                                          | What it does                                                                                                                                                           | Why                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` (in gdp-backend)                   | API on `localhost:3000` (Hono + tsx watch) plus `docker compose up` for DDB Local + MinIO. The `dev-bootstrap.ts` script creates the DDB table + S3 bucket if missing. | Backend                                                                                                              |
| `npm run web` (in gdp-mobile)                    | Expo web bundler on `localhost:8081`                                                                                                                                   | Mobile                                                                                                               |
| `cloudflared tunnel --url http://localhost:3000` | Picks a fresh `https://*.trycloudflare.com` URL, forwards to backend                                                                                                   | iOS Safari needs HTTPS for Web Crypto + camera + service workers                                                     |
| `cloudflared tunnel --url http://localhost:8081` | Same shape, for the mobile bundle                                                                                                                                      | iPhone needs to load the app over HTTPS                                                                              |
| `cloudflared tunnel --url http://localhost:9000` | Same shape, for MinIO                                                                                                                                                  | Bill upload uses a presigned S3 PUT URL; the URL embeds the S3 endpoint hostname, so MinIO needs a stable HTTPS face |

Plus DynamoDB Local + MinIO as docker containers (managed by `npm run dev`'s `docker compose up`, not separate shells).

### One-command bundling for iPhone mode

```bash
npm run dev:tunneled   # in gdp-backend
```

Wraps all 5 processes with prefixed output and a Ctrl+C handler that kills everything. Assumes `gdp-mobile` is a sibling directory; override with `GDP_MOBILE_DIR=/path/to/gdp-mobile`.

Caveat: cloudflared "quick tunnels" generate **fresh URLs every run**. After the script starts, you still have to:

1. Copy the backend tunnel URL → set `EXPO_PUBLIC_API_BASE_URL` for the mobile bundle
2. Copy the mobile tunnel URL → set `EXPO_PUBLIC_PUBLIC_BASE_URL` (so the QR encodes the right URL)
3. Copy the MinIO tunnel URL → set `S3_ENDPOINT` in `.env.local` and restart the backend

To avoid this dance forever, set up cloudflared **named tunnels** with a `~/.cloudflared/config.yml` mapping stable subdomains (e.g. `gdp-backend.<you>.dev`) to local ports. One-time setup, then URLs never change. See [cloudflared named tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/). Out of scope for this doc.

## Why iPhone mode is so much heavier

- **iOS Safari security**: Web Crypto API (used by `expo-crypto` for SHA-256 of bill images and PKCE for OAuth) and `getUserMedia` (camera) are restricted to HTTPS or `localhost`. Plain HTTP on a LAN IP doesn't qualify. Each leg (mobile bundle, backend, MinIO) needs its own HTTPS face → three tunnels.
- **MinIO presigned URLs are signed for a specific hostname**: AWS SigV4 includes the host in the signature. Generating a URL signed for `localhost:9000` and serving it through a different hostname breaks the signature, so the backend has to be told the public S3 hostname (`S3_ENDPOINT` env var) at signing time.

## Stopping everything

If you started via `npm run dev:tunneled`: just Ctrl+C.

If you started piecemeal:

```bash
# Kill the bundler + tsx + cloudflareds:
pkill -f "expo start --web"
pkill -f "tsx watch src/local.ts"
pkill -f "cloudflared tunnel"

# Stop the docker stack (optional — they're cheap to leave running):
docker compose down  # in gdp-backend
```

## Process count cheat sheet

| Mode           | Backend | Mobile | Tunnels | Docker                   | Total long-runners |
| -------------- | ------- | ------ | ------- | ------------------------ | ------------------ |
| Laptop-only    | 1       | 1      | 0       | 2 (containers, detached) | 2 shell processes  |
| iPhone-testing | 1       | 1      | 3       | 2 (containers, detached) | 5 shell processes  |
