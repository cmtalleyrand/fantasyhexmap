# Optional key-holding proxy

Use this **only if other people will use your deployed page**. If you are the only
user, do not deploy it: the static site already asks you for your own key and keeps it
in your browser, which is simpler and gives an attacker nothing to steal from the site.

## What it is for

GitHub Pages is static hosting. There is no server, so there is nowhere to put a shared
API key that visitors cannot read — a key baked in at build time is readable in the
published bundle by anyone who opens DevTools. This Worker is the missing server: it holds
the key as a Cloudflare secret and exposes the same `/api/health` and `/api/generate`
endpoints the local Express server does, so the browser build talks to it without changing
a line of application code.

## Deploy

```bash
cd worker
npx wrangler secret put ANTHROPIC_API_KEY     # paste the key; it is encrypted at rest
npx wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to your Pages origin
(`https://YOUR-USERNAME.github.io`) and deploy again.

Finally, in the GitHub repository, add a **repository variable** (Settings → Secrets and
variables → Actions → Variables) named `VITE_API_BASE` with the Worker's URL, e.g.
`https://fantasyhexmap-api.YOUR-SUBDOMAIN.workers.dev`. The next Pages build will point at
it, and the site stops asking visitors for a key.

Note that this is a *variable*, not a *secret*: it is a public URL that ends up in the
bundle, which is fine. The key itself never goes near the repository.

## What this does and does not protect

It keeps the key out of the bundle, out of the repository, and out of every visitor's
browser. That is the part that matters.

It does not authenticate callers. Anyone who learns the Worker's URL can spend your
Anthropic credit through it, and `ALLOWED_ORIGINS` only stops a browser on another site
from doing so casually — it is trivially forged by anything that is not a browser. If the
page is genuinely public, put a spend limit on the key, and consider adding a shared
passphrase check or Cloudflare Access in front of the Worker.
