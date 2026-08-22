# Migration QA — Render Service (Phase 2)

Playwright service that powers **Responsive / Layout** automation for Content Migration QA.

The main app already calls this when `RENDER_SERVICE_URL` is set.
**Content, Links / Tracking, Technical, and Final Review are unchanged.**

## What it measures

| Signal | Used for |
|--------|----------|
| `overflow` | No horizontal overflow / scrollbar |
| `header1800` | Header checked at 1800px+ |
| `mobile360` | Mobile layout down to 360px |
| `mobileTablet` | Mobile and tablet views |
| `stacking` | Image → title → content stacking on mobile |

Ambiguous cases return `pass: null` → the QA UI shows **Needs review** (honest fallback).

## Run locally

```sh
cd render-service
npm install          # also installs Chromium via postinstall
npm start            # http://127.0.0.1:3099
```

Optional auth:

```sh
export RENDER_SERVICE_TOKEN=your-secret
npm start
```

### Point the QA app at it

In the **main app** `.env` (or host env):

```env
RENDER_SERVICE_URL=http://127.0.0.1:3099
RENDER_SERVICE_TOKEN=your-secret
```

Restart the QA app, then run a batch. Responsive checks should Pass/Fail instead of all "Needs review".

## Docker

```sh
docker build -t migration-qa-render .
docker run --rm -p 3099:3099 -e RENDER_SERVICE_TOKEN=your-secret migration-qa-render
```

## API

`POST /render`

```json
{ "url": "https://example.com/page", "token": "your-secret" }
```

```json
{
  "ok": true,
  "results": {
    "overflow": { "pass": true, "detail": "..." },
    "header1800": { "pass": true, "detail": "..." },
    "stacking": { "pass": true, "detail": "..." },
    "mobile360": { "pass": true, "detail": "..." },
    "mobileTablet": { "pass": true, "detail": "..." }
  }
}
```

`GET /health` → `{ "ok": true }`
