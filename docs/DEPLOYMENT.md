# GitHub Pages deployment

The application is a static Vite site. Its project URL is
`https://daluoter.github.io/FPV-Drone-Trainer/` after a successful deployment.

## Enable and deploy

1. In the repository, open **Settings → Pages** and select **GitHub Actions**
   under **Build and deployment → Source**.
2. Ensure `.github/workflows/deploy.yml` is committed to `main`.
3. Open **Actions → Deploy GitHub Pages → Run workflow**, select `main`, and run.
4. Wait for tests, lint, build, and deployment to succeed. Open the URL shown by
   the deployment or **Settings → Pages → Visit site**.

Production deployment is manual and restricted to `main`. Pushing changes does
not publish them. The workflow uses GitHub's generated token; no personal access
token or application secrets are required. Repository Actions policies must allow
the official `actions/*` steps, and the repository plan must support Pages.

## Local production check

From the repository root with Node.js 24 and npm installed:

```bash
npm ci
npm test
npm run lint
npm run build -- --base=/FPV-Drone-Trainer/
npm run preview -- --base=/FPV-Drone-Trainer/ --host 127.0.0.1 --port 5180 --strictPort
```

Open the preview at `/FPV-Drone-Trainer/`. Check that assets load, the logo stays
at the project URL, WebGL renders, and the explicit keyboard fallback can arm and
disarm. The deployment build sets Vite's base path through the CLI; normal local
development keeps the root path. If using a custom domain at its root, change the
deployment build's base to `/`.

Real Gamepad/transmitter checks still require a supported desktop browser and
physical hardware. Settings and progress are browser-local. Paths under the same
`daluoter.github.io` origin share localStorage, so a second repository path alone
does not isolate UAT data from production.
