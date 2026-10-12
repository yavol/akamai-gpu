# akamai-gpu

Public MIT-licensed scaffold for Codex Cloud work.

This repository provides lightweight Python dependencies for working with notebooks and OpenAI-compatible APIs. GPU inference can run on a separately configured service.

## Setup

Create a Codex Cloud environment from this repository. Ask the setup agent to create a Python virtual environment and install requirements.txt, then verify the imports. Keep environment access set to Only me and review the setup report before publishing.

Configure service endpoints and credentials privately in the environment settings or Personal vault. Supply prior chat context directly to private cloud chats. Workshop addresses, credentials, deployment details, and local chat exports are not published in this repository.

## Local setup

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -c 'import requests, websocket, openai, nbformat, PIL; print("Dependencies ready")'
```

MIT licensed. No model weights are bundled.
