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
