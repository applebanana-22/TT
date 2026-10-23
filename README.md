# Social Poster

A small, real (not mocked) app that connects a **Facebook Page** and a **TikTok** account with OAuth and publishes a **photo** to them.
It's built for learning, so the code is commented to explain *why* each step exists.

- Node.js 20.6+ · Express · plain HTML/JS (no build step)
- 2 dependencies: `express`, `multer`

## Quick start

```bash
npm install
cp .env.example .env       # then fill it in (see below)
npm run gen-key            # paste the output into TOKEN_ENCRYPTION_KEY
npm run dev                # http://localhost:3000
```

The app starts even with no credentials. Unconfigured platforms show a disabled Connect button and say what's missing.

## 1. Public HTTPS URL (required for TikTok)

TikTok requires an **HTTPS** redirect URI, and it **downloads your photo from a public URL** (photo posting only supports `PULL_FROM_URL`). For local development, use a tunnel:

```bash
ngrok http 3000            # use a static ngrok domain so the URL doesn't change
```

Set `PUBLIC_BASE_URL=https://<your-domain>` in `.env`, restart the app, and **always open the app at that URL**, not at `localhost`. The OAuth state cookie is tied to one domain, so starting the login on `localhost` and returning to the ngrok URL fails the CSRF check. The UI warns you when this happens.

## 2. Facebook setup

1. Go to <https://developers.facebook.com/apps> and create an app (use case: **Manage everything on your Page**, or a Business app with Facebook Login).
2. Under **Facebook Login → Settings**, add the valid OAuth redirect URI: `{PUBLIC_BASE_URL}/auth/facebook/callback`
3. Copy the **App ID** and **App Secret** into `.env`.
4. You need a **Facebook Page** that you administer. The Graph API **can't post to personal profiles**.
5. While the app is in **Development mode**, only people with a role on the app (admin/developer/tester) can connect. That's fine for testing. To go public, you need App Review for `pages_manage_posts`, `pages_read_engagement`, and `pages_show_list`.

## 3. TikTok setup

1. Go to <https://developers.tiktok.com/>, create an app, and add the products **Login Kit** and **Content Posting API**.
2. In Login Kit, add the redirect URI: `{PUBLIC_BASE_URL}/auth/tiktok/callback`
3. Add the scopes `user.info.basic`, `video.publish` (Direct Post), and `video.upload` (send to inbox as a draft).
   Set `TIKTOK_SCOPES` in `.env` to match what you were granted.
4. **Verify URL ownership** for `{PUBLIC_BASE_URL}/media/` (Content Posting API → URL properties). If you choose the file method, put the `tiktok....txt` file TikTok gives you into `public/`. It's then served at the site root.
5. Add your TikTok account as a **target user / sandbox tester**.
6. Copy the **Client key** and **Client secret** into `.env`.

**Limits for unaudited apps (expected while testing):** Direct posts are visible to **Only me** (`SELF_ONLY`), only a handful of users can post per day, and the TikTok account may need to be set to private. After TikTok audits your app, these limits are lifted.

## How it works

### Connection states (`src/lib/connection.js`)

Every account is always in exactly one state, and the UI renders its buttons from that state:

| State          | Meaning                                                        | Buttons                          |
|----------------|----------------------------------------------------------------|----------------------------------|
| `disconnected` | No account linked                                              | Connect                          |
| `connecting`   | The user was sent to the login page; we're waiting for the callback | Restart login               |
| `connected`    | Tokens are valid. Posting is allowed **only** in this state     | Test connection, Reconnect, Disconnect |
| `expired`      | We had access but lost it (revoked, password changed, refresh failed) | Reconnect, Disconnect      |
| `error`        | Connecting or verifying failed (e.g. a permission was declined, no Pages) | Reconnect, Test, Disconnect |

Details worth studying:
- **Abandoned logins:** `connecting` times out after 10 minutes. If the user cancels a *re*connect, the previous working connection is restored (`previousStatus`).
- **Automatic expiry:** any API call that returns an auth error (Facebook code 190, TikTok `access_token_invalid`, or a 401) moves the account to `expired` (`withAuthHandling` in `src/providers/index.js`).
- **Permission checks at connect time:** if the user unticks a required permission, connecting ends in `error` right away, so it doesn't fail later when you post. Facebook is then asked again with `auth_type=rerequest`.
- **Invalid transitions throw an error**, which catches logic bugs early. Every transition is logged, e.g. `[tiktok] connecting -> connected`.

### OAuth security (`src/lib/oauthState.js`)
- A random `state` is stored on the server **and** in an httpOnly cookie. The callback must match both, so a forged callback can't link someone else's account (CSRF).
- Each state is single-use and expires after 10 minutes.
- Tokens are **encrypted at rest** with AES-256-GCM (`src/lib/crypto.js`) and are **never sent to the browser**.
- Facebook calls are signed with `appsecret_proof`.

### Token lifecycles
- **Facebook:** code → short-lived user token → **long-lived user token (~60 days)** → **Page tokens**, which don't expire. Posts use the Page token. If only the user token dies, *Test connection* falls back to checking the Page token.
- **TikTok:** access token lasts 24h and refresh token ~365 days. `getAccessToken()` refreshes 5 minutes before expiry, and concurrent requests share a single refresh (single-flight).

### Posting
1. The server sniffs the file's real type from its magic bytes and checks each platform's rules (Facebook: max 4 MB; TikTok: JPEG/WEBP only).
2. **Facebook:** the photo bytes are uploaded directly (`POST /{page-id}/photos`, multipart). The result is immediate.
3. **TikTok:** `creator_info` is checked again on the server (the privacy level must be one TikTok offered), then `content/init` is called with the public `/media/...` URL. TikTok processes the post **asynchronously**, so the UI polls `status/fetch` until it reaches `PUBLISH_COMPLETE`, `SEND_TO_USER_INBOX`, or `FAILED`.
4. Each platform succeeds or fails independently. Partial success is shown per platform in History.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "State does not match this browser" | You started on `localhost` but returned to the ngrok URL. Open the app at `PUBLIC_BASE_URL`. |
| Facebook: "no Facebook Pages were shared" | In the Facebook dialog, choose **Edit settings** and select your Page. You must be an admin/editor of it. |
| Facebook: "URL blocked" in the dialog | The redirect URI isn't in *Valid OAuth Redirect URIs* (it must match exactly). |
| TikTok: `redirect_uri` error on the login page | The URI must be HTTPS and match the portal exactly. |
| TikTok: `url_ownership_unverified` | Verify the `/media/` URL prefix or domain in the TikTok portal. |
| TikTok: `unaudited_client_can_only_post_to_private_accounts` | Choose **Only me**, and/or make the TikTok account private. |
| TikTok status stays `processing` → `FAILED` with a download error | TikTok couldn't fetch `{PUBLIC_BASE_URL}/media/<file>`. Open that URL from another network to check it's reachable. |

## Project layout

```
src/
  server.js              app wiring, static /media for TikTok
  config.js              env + startup validation
  lib/connection.js      connection state machine
  lib/oauthState.js      CSRF state
  lib/crypto.js          token encryption, appsecret_proof
  lib/store.js           JSON-file DB with atomic writes (data/db.json)
  lib/media.js           upload, file-type sniffing, per-platform rules
  lib/http.js            fetch wrapper + ProviderError
  providers/facebook.js  Graph API
  providers/tiktok.js    Login Kit v2 + Content Posting API
  routes/auth.js         /auth/:provider/start|callback
  routes/api.js          /api/accounts, /api/posts, ...
public/                  UI (index.html, app.js, styles.css)
```

**Not included (on purpose, to keep the scope small):** a login for the app itself (it's single-user and meant to run locally), multi-photo carousels, scheduling, and video.
