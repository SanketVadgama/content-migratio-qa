# Content Migrate Buddy

Create a blank Content Migration QA application.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://content-migratio-qa.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/6a4c2882-bc71-4daf-a955-3acae772ee6e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

### Publishing (Lovable hosts the app)

The production site is on **Lovable**, not Vercel.

1. Push (or sync) changes to the connected GitHub branch (`main`).
2. In Lovable, open **Publish** → **Publish changes** to update the live URL.

GitHub Actions does **not** replace Lovable publish. CI only verifies the build; the optional Deploy workflow builds the Phase 2 render-service image.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Phase 2 — Responsive / Layout automation (optional)

Content, Links, Technical, and Final Review checks are unchanged.

To auto-run **Responsive / Layout** (overflow, 360px, tablet, header 1800px, stacking):

```sh
cd render-service
npm install
npm start
```

In the main app environment (Lovable project env / local `.env`):

```env
RENDER_SERVICE_URL=http://127.0.0.1:3099
RENDER_SERVICE_TOKEN=
```

Restart the QA app and re-run a batch. See `render-service/README.md` for Docker and API details.

## GitHub Actions

Workflows live in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|----------------|
| **CI** | Push & PR to `main` | `bun install`, lint, production build (catch breakages) |
| **Deploy** | Changes under `render-service/` or manual | Build & push Playwright render image to **GHCR** |

The **main app stays on Lovable**. Actions do not deploy the web app.

### Optional CI secrets

GitHub → **Settings → Secrets and variables → Actions**

| Secret | Purpose |
|--------|---------|
| `VITE_SUPABASE_URL` | CI production build |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | CI production build |
| `VITE_SUPABASE_PROJECT_ID` | CI production build |
| `RENDER_SERVICE_URL` | Optional — public URL of the render-service |
| `RENDER_SERVICE_TOKEN` | Optional — shared token if the service uses auth |

### Render-service image (Phase 2)

On changes under `render-service/` (or **Actions → Deploy → Run workflow**):

```text
ghcr.io/<your-github-user-or-org>/migration-qa-render:latest
```

```sh
docker pull ghcr.io/<owner>/migration-qa-render:latest
docker run -d -p 3099:3099 -e RENDER_SERVICE_TOKEN=your-secret ghcr.io/<owner>/migration-qa-render:latest
```

Point `RENDER_SERVICE_URL` at that host in **Lovable** env (and GitHub secrets if you use them in CI).
