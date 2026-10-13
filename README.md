# akamai-gpu

Public MIT-licensed tools for GPU inference experiments and browser demos.

This repository provides lightweight Python dependencies for working with notebooks and OpenAI-compatible APIs. GPU inference can run on a separately configured service.

## Decision Lab

[Decision Lab](decision-lab/README.md) contains three working browser demos: a visual courier game, support-ticket routing with form filling, and supplier comparison with purchase-request drafts. It supports self-hosted Clef/SGLang inference and optional OpenRouter Clef, Jev, and GPT-6 Luna comparisons.

```sh
python decision-lab/server.py --port 8080
```

Configure `GPU_DECISIONS_URL` and/or `OPENROUTER_API_KEY` privately in the server environment. The frontend enables configured backends, shows setup reasons for unavailable models, and records actual model choices and request latency. Source, automated tests, synthetic benchmark evidence, and [workshop deployment tooling](decision-lab/deploy/README.md) are included. No API keys or model weights are bundled.

The workshop deployment is operational through Jupyter Server Proxy's authenticated `/proxy/8081/` route, with the existing Service port and targetPort kept at 8080. [Acceptance evidence](decision-lab/evidence/public-route-acceptance.json) records the authentication gate, app assets, and successful text/image controls. [Browser checks](decision-lab/evidence/public-route-browser.json) exercised the public route through a TLS-verified relay, completing three text tasks and the image courier. The notebook remains ephemeral: retain private recovery backups; this is not durable production hosting. Alternative gateway tooling remains experimental. Relay and historical bridge timings are labeled explicitly.

## Price estimates

Recovered from the October 12, 2026 cost estimates and proxy benchmarks; list prices rechecked on the same date. All amounts are USD. Monthly hosting estimates assume 730 billable hours.

### Akamai RTX 4000 Ada hosting

These [North America list prices](https://www.akamai.com/cloud/pricing/gpu) include the VM's CPU, host RAM, and listed local storage.

| Plan | GPUs | Host RAM | Per hour | 24 hours | 730-hour month |
|---|---:|---:|---:|---:|---:|
| x1 Small | 1 | 16 GB | $0.52 | $12.48 | $379.60 |
| x1 Medium | 1 | 32 GB | $0.67 | $16.08 | $489.10 |
| x1 Large | 1 | 64 GB | $0.96 | $23.04 | $700.80 |
| x2 Small | 2 | 32 GB | $1.05 | $25.20 | $766.50 |

The original single-GPU budget was about **$490/month** on Medium, or **$380/month** on Small. Larger host RAM leaves the card's 20 GB VRAM unchanged; model fit and throughput on the cheapest plan need validation. Taxes, egress, extra storage, load balancers, redundancy, and engineering are excluded. [Powered-off VMs remain billable](https://www.akamai.com/cloud/pricing/gpu#faq) until removed; [GPU plans have no monthly billing cap](https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works).

### Hosted decision API prices

Prices vary by provider. The original estimates used Cloudflare's rate; the live listings also show lower Prime Intellect rates.

| Model | OpenRouter provider | Input / million tokens | Output / million tokens |
|---|---|---:|---:|
| [Clef-flash](https://openrouter.ai/cloudflare/clef-flash) | Cloudflare (original baseline) | $0.038 | $0 |
| [Clef-flash](https://openrouter.ai/cloudflare/clef-flash) | Prime Intellect | $0.021 | $0 |
| [Clef](https://openrouter.ai/cloudflare/clef) | Cloudflare | $0.240 | $0 |
| [Clef](https://openrouter.ai/cloudflare/clef) | Prime Intellect | $0.042 | $0 |
| [Jev 1.13](https://openrouter.ai/typesafe/jev-1.13) | TypeSafe | $0.042 | $0 |
| [Microsoft-Decision-1](https://openrouter.ai/microsoft/microsoft-decision-1) | Azure | $0.042 | $0 |

### When hosting becomes cheaper

For the **$0.52/hour Small** plan, compute-only break-even is **3,801 input tokens/second** against Cloudflare's $0.038/M rate, or **6,878 input tokens/second** against Prime Intellect's $0.021/M rate. At 3,000 billable tokens/request, that is **1.27** or **2.29 requests/second**, respectively, averaged over every billable hour. The original $0.67/hour Medium estimate requires **1.63 requests/second** at 3,000 tokens against Cloudflare.

Calculation: `break_even_tokens_per_second = hourly_host_cost * 1,000,000 / (3,600 * API_price_per_million_input_tokens)`. These are financial thresholds; achieving that throughput still needs a model benchmark.

The historical performance proxy used **RedHatAI/Qwen3.5-9B-FP8-dynamic on an RTX 4000 Ada**, fresh synthetic prompts/images, and one generated output token. It measured 416 requests across runs lasting 29–48 seconds.

| Workload | Concurrent requests | Input tokens/second | Hosting cost / million input tokens | Savings vs Cloudflare $0.038/M |
|---|---:|---:|---:|---:|
| Short text (~920 tokens) | 1 | 5,089 | $0.0284 | 25.3% |
| Long text (~2,696 tokens) | 4 | 5,122 | $0.0282 | 25.8% |
| 1024×768 image + short text | 4 | 3,910 | $0.0369 | 2.8% |
| Image + longer history (~3,466 tokens total) | 4 | 4,613 | $0.0313 | 17.6% |

**These are Qwen FP8 proxy results, not Clef-flash measurements.** The hosting cost assumes $0.52/hour and continuous measured throughput; the workshop VM's CPU/RAM could not be verified as the Small plan. Idle time raises the cost per token. At Prime Intellect's listed $0.021/M rate, the hosted API is cheaper than all four proxy results.

Comparisons assume equivalent processed input tokens, including images. [Workers AI currently truncates text state to roughly 2,000 tokens](https://openrouter.ai/docs/guides/community/multimodal-decisions#limits); longer-history rows require a provider processing equivalent input. Clef quantization, decision quality, and sustained production throughput need separate validation.

## Setup

Create a Codex Cloud environment from this repository. Ask the setup agent to create a Python virtual environment and install requirements.txt, then verify the imports. Keep environment access set to Only me and review the setup report before publishing.

Configure service endpoints and credentials privately in the environment settings or Personal vault. Supply prior chat context directly to private cloud chats. Workshop addresses, credentials, live deployment state, and local chat exports are not published in this repository.

## Local setup

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -c 'import requests, websocket, openai, nbformat, PIL; print("Dependencies ready")'
```

MIT licensed. No model weights are bundled.
