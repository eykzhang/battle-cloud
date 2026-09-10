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

Cloudflare Pages, connected to this repository. The settings that matter:

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variable | `VITE_API_BASE_URL` |

Pages is the one piece of this project's infrastructure outside AWS. Everything else is
Terraform in `../infra`; a static site needs a CDN and nothing else, and Pages does that on
a push with no build job of ours and no bucket to configure. The API's CORS configuration
already allows any origin, so no Terraform change is needed when the site's hostname
appears or changes.

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
