# battle-cloud web client

React and TypeScript over Vite. Submit a Showdown replay, watch the job, read the analysis:
a win-probability curve, the cost of each played move, and the ranked actions the engine
considered on any turn.

```
npm install
npm run dev        # http://localhost:5173, against the deployed API
npm run build      # typecheck, then a static bundle in dist/
```

`VITE_API_BASE_URL` points the client at an API. It defaults to the deployed service, so
`npm run dev` works with no configuration; set it to `http://localhost:8080` to develop
against compose.

## Hosting

Cloudflare Workers, connected to this repository, serving static assets with no Worker script:
`wrangler.jsonc` is the whole deployment. Cloudflare routes new git connections through Workers
rather than Pages now, and this is the path they are developing.

The dashboard's build settings:

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION` = `22` |

`NODE_VERSION` matters: the default is older than Vite 6 accepts, and the failure is a build-log
error about an unsupported engine rather than anything about this code.

`VITE_API_BASE_URL` is optional. It defaults to the deployed API, so the site works without it.

This is the one piece of the project's infrastructure outside AWS. Everything else is Terraform
in `../infra`; a static site needs a CDN and nothing else, and this deploys itself on a push with
no build job of ours and no bucket to configure. The API's CORS configuration already allows any
origin, so no Terraform change is needed when the site's hostname appears or changes. The
reasoning, including what the exception costs, is in
`../notes/decision-cloudflare-pages-for-the-web-client.md`.

## Design notes

**Two charts, never one with two axes.** Win probability is a probability and cost is a
difference between two action values. Sharing an axis would invite reading a crossing point
that means nothing, and giving them separate scales in one frame is the dual-axis chart,
where any relationship the author wants appears by choosing scales. They are stacked
instead, on a shared turn axis.

**A gap in the curve is a gap in the data.** Turns the engine could not evaluate break the
line rather than interpolating across it, because a straight segment through a missing turn
is a claim the analysis does not make.

**The numbers are always available.** Every chart has a table view behind one button, which
is also what makes the page readable without color.

**Hash routing, hand-rolled.** Three routes, no nesting. It also means a static host serves
one file for every URL with no redirect rules.
