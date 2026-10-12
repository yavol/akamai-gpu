# Decision Lab

Three browser demos with real decisions from self-hosted Clef GPU inference and optional OpenRouter models. The browser talks to one Python server; credentials and private inference URLs stay on that server.

1. **Neon Courier** — a seeded warehouse game. A model selects each move from its current observation; text and image modes are available.
2. **Inbox to action** — classify four synthetic support requests, populate real browser form controls, and file them into a local work queue.
3. **Procurement desk** — compare supplier offers against stock, delivery, and budget constraints, then fill purchase-request drafts from the selected source record.

The business workspaces are synthetic, bounded browser sandboxes. They do not operate external websites or submit real tickets/orders. The model selects options; ordinary code copies source values and applies the browser action. All API calls are real. There are no scripted answers, hidden fallback models, or latency handicaps.

## Run

Python 3.10+; no third-party runtime dependencies.

```bash
cd decision-lab
# Supply GPU_DECISIONS_URL and/or OPENROUTER_API_KEY through your secret manager.
python server.py --port 8080
```

Open `http://localhost:8080/` on the server host. On a remote pod, use its authenticated ingress or supported port proxy. Assets and API calls resolve relative to the app directory, including a Jupyter `/proxy/8080/` URL; retain the trailing slash. The server and model can run in the same pod, with inference reachable only on loopback. No frontend build is required.

Use `.env.example` as a configuration reference; this application reads the process environment and does not automatically load `.env` files. OpenRouter is optional for a GPU-only deployment. A managed cloud environment’s injected credential placeholders are not portable secrets: supply a valid OpenRouter key separately to enable hosted comparisons on another host. The adapter uses the host’s configured proxy and CA trust. Keep the demo behind the workshop’s authenticated ingress when deploying; the Python server itself does not implement login.

[Workshop deployment tools](deploy/README.md) are included as experimental options. Their source tests pass, but public deployment has not been verified end to end and no public demo URL is confirmed. Workshop network routing restricted the deployment attempts; the saved browser results below cover the earlier OpenRouter demos, not a successful public GPU deployment.

## Model switching

| UI model | Requested model | Interface |
|---|---|---|
| Clef Flash | `cloudflare/clef-flash` | OpenRouter Decisions; Cloudflare provider pinned |
| JEV 1.13 | `typesafe/jev-1.13` | OpenRouter Decisions; text only |
| GPT-6 Luna | `openai/gpt-6-luna` | Chat completions, strict JSON schema, reasoning effort `none` |
| Luna Decisions | `openai/gpt-6-luna-decisions` | Optional native Decisions comparison |
| Akamai GPU · Clef FP8 | `Cloudflare/clef-flash` by default, configurable | Self-hosted SGLang `/v1/systemone` |

The UI loads the actual server catalog and selects the GPU first when configured. Unconfigured providers stay visible with their setup reason. Comparison is enabled only when at least two configured models support the current observation mode. The selected provider is sent with every request; failures never silently switch models.

Jev cannot be selected for image observations. Clef and Luna receive a canvas-rendered observation plus short task instructions in visual mode; no hidden structured state or answer is attached. In the business demos this is a rendered document snapshot, not a screenshot scraped from an external browser. Image payloads are below 200 KB in current fixtures.

Clef is pinned to Cloudflare with `allow_fallbacks: false`: an initial routing probe through PrimeIntellect misclassified a simple color image. See `evidence/provider-probes.json` for final successful probes. No model provider is silently changed on failure.

## Configure self-hosted GPU inference

Set these server variables, then restart:

```text
GPU_DECISIONS_URL=https://your-private-endpoint/v1/systemone
GPU_MODEL_ID=Cloudflare/clef-flash
GPU_MODEL_LABEL=Akamai GPU · Clef FP8
GPU_API_KEY=<optional server-side credential>
```

`GPU_DECISIONS_URL` is the complete endpoint URL, not a base URL. SGLang exposes the native decision route at `/v1/systemone`. Use an address reachable from the Python server (loopback when inference is colocated). `GPU_MODEL_ID` must match the model server’s served model name; a container image tag is not a model ID. The workshop service reports `Cloudflare/clef-flash` and runs FP8 inference. The GPU option activates when its endpoint is configured. Readiness in the menu means configuration is present, not that the upstream service has passed a health check. The endpoint receives:

```json
{
  "model": "Cloudflare/clef-flash",
  "state": "The parcel is red.",
  "questions": {
    "color": {
      "type": "choice",
      "instructions": "Which color is the parcel?",
      "criteria": {"red": "Red parcel", "blue": "Blue parcel"}
    }
  }
}
```

Return `{"answers":{"color":{"choice":"red","confidence":0.98,"probabilities":{"red":0.98,"blue":0.02}}}}`. Optional `model`, `usage`, and `id` metadata is preserved. For images, `state` is an array containing strings and `{ "type":"image_url", "image_url":{"url":"data:image/png;base64,..."} }` parts. Confidence/probabilities can be omitted if unsupported. The current SGLang service does not report inference-only timing; the app reports measured request wall time and does not infer GPU forward-pass latency from it. The GPU model ID and requested ID are preserved in live exports, independent of the hosted-provider benchmarks below.

## Measurement and verification

- The UI reports **provider round-trip wall time**, including proxy/network/routing and response validation. It is not GPU-only forward-pass latency.
- Task time is browser wall time, including the full observation/decision/action loop. Compared game trajectories can diverge after model mistakes.
- All first calls are included. There are no discarded warmups, fixed model delays, local answer caches, or retry fallbacks. Upstream caching may still occur.
- UI percentiles use nearest rank. The frozen benchmark uses linear interpolation, explicitly recorded in its JSON.
- A business step is correct only when all requested fields match the policy. Game decisions score shortest-path moves separately from completing all checkpoints. Hitting the move limit is **incomplete**; an incorrectly filed business case is **needs review**.
- Native probabilities are displayed only when actually returned. Luna chat has no invented confidence values.
- Side-by-side runs intentionally overlap network requests. The frozen benchmark sends identical observations sequentially and rotates provider order each repeat.

```bash
python -m unittest discover -s tests -v
python scripts/probe_providers.py
# Requires installed Playwright and Chromium; see browser configuration below.
node scripts/benchmark_freeze.cjs
python scripts/benchmark_providers.py
QA_LIVE=1 node scripts/browser-test.cjs
QA_LIVE=1 QA_VISION=1 QA_ONLY=vision node scripts/browser-test.cjs
```

Browser scripts use a local `playwright` package when installed, with an optional `PLAYWRIGHT_MODULE` override and a managed-workspace fallback. Set `CHROMIUM_PATH` to use a particular browser; otherwise they use an available system Chromium or Playwright's installed browser. Set `APP_URL` (or `QA_URL`) to the app directory URL, including its trailing slash, to test a deployment under a path prefix. The original `browser-test.cjs` and `browser-final.cjs` suites reproduce the saved OpenRouter checks; their model assumptions are not suitable for a GPU-only catalog.

`evidence/benchmark.json` holds final same-observation comparisons; `evidence/frozen-observations.json` holds their source tasks and scoring labels. Scoring labels never enter the model requests. `evidence/browser-qa-*.json`, browser exports, and screenshots record actual browser tests. Initial results are preserved separately from clarified-prompt results. The test fixtures are small and synthetic; results are illustrative rather than broad model rankings.

The UI's Export JSON action saves the current session's raw request metadata, answers, accuracy, timings, model identity, and methodology. No API key or image data is exported.

### Saved OpenRouter results — October 12, 2026

The saved 54-request frozen-text run through OpenRouter passed all 18 observations and all 30 named choices per model. These historical hosted-provider timings do not measure self-hosted GPU inference:

| Model | p50 request | p95 request |
|---|---:|---:|
| Clef Flash, Cloudflare | 435 ms | 606 ms |
| JEV 1.13 | 314 ms | 349 ms |
| GPT-6 Luna chat | 1,162 ms | 2,211 ms |

Final live browser tests passed all four support and procurement cases for Clef and Luna. JEV passed all four procurement cases and all 10 courier moves (five checkpoints). Clef's image-mode courier passed all 10 moves in 5.63 seconds. An earlier Luna game run reached only two checkpoints before the 18-move cap; the UI now explicitly marks this outcome incomplete. Initial Clef business misses and the subsequent shared policy clarifications remain visible in the historical evidence.

Chromium also verified desktop/mobile layout, real form population, model and observation selectors, repeated stopping/restarting, JSON export, and a mocked failure path for the move cap. The mocked failure-path test is excluded from live benchmark results. The historical verification also passed the original fifteen backend unit tests; run the test command above for the current adapter suite. See `evidence/browser-qa-final.json` and `evidence/browser-final-export.json`.

## Research references

- [Browser Use × Jev Ultrafast](https://github.com/browser-use/jev-ultrafast): bounded browser action/target selection.
- [Jev Arcade](https://github.com/codaaiteam/jev-arcade) and [Jev game playground](https://github.com/laxminarayanaboga/jev-playground): game action loops.
- [Cloudflare Clef announcement](https://blog.cloudflare.com/clef-decision-models/): support routing, domain intelligence, and decision-model business cases.
- [Microsoft Decision-1](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/): shopping agents, feedback tagging, incident retrieval.
- [TypeSafe candidate extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): selecting source values rather than generating arbitrary strings.
- [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev) and [multimodal decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions): native contracts and modality limits.

Vendor latency claims are background context only. All reported app measurements come from this app's actual requests.
