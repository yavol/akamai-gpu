# Workshop Kubernetes deployment

Deployment status: **operational through official Jupyter Server Proxy**. [Sanitized acceptance evidence](../evidence/public-route-acceptance.json) records anonymous redirects to authentication, authenticated app assets and health, five correct text controls, and three correct image controls. Notebook WebSocket execution passed separately; the temporary rollback watchdog was confirmed disarmed. These checks establish the workshop route's operation, not durable production hosting or a test from a user's laptop browser. Private hostnames and recovery details remain outside this repository.

[Public-route browser evidence](../evidence/public-route-browser.json) also records local headless Chromium using a TLS-verified relay to reach the official authenticated proxy. Three text tasks and image courier completed across 30 real calls, with mobile layout and JSON export checked. The relay adds transport overhead; browser timing is labeled accordingly, and no direct laptop-browser measurement is claimed.

## Preferred workshop route: Jupyter Server Proxy

The official Jupyter Server Proxy extension now exposes the loopback app through Jupyter's authenticated `/proxy/8081/` path. Keep the existing workshop Service port **8080** and targetPort **8080**. The extension was installed in the same Python environment as Jupyter and loaded during its planned restart; authenticated route checks then passed.

For a new installation, select the Python executable used by the actual Jupyter server, install the verified extension version in that environment, enable it, and inspect its registration. If that interpreter has no `pip` module, use the `uv` alternative shown below instead of the first command:

```bash
"$JUPYTER_PYTHON" -m pip install "jupyter-server-proxy==4.6.0"
# Equivalent for a uv-managed server environment without pip:
# uv pip install --python "$JUPYTER_PYTHON" "jupyter-server-proxy==4.6.0"
"$JUPYTER_PYTHON" -m jupyter server extension enable --py jupyter_server_proxy --sys-prefix
"$JUPYTER_PYTHON" -m jupyter server extension list
```

The running Jupyter server loads the extension at startup. Before a planned restart, preserve the notebook's ephemeral home contents, application source, private configuration, and required startup instructions. Restart through the platform's supported lifecycle with its existing configuration. Run the app on loopback using privately configured `GPU_DECISIONS_URL` and an optional credential file:

```bash
"$APP_PYTHON" "$DECISION_LAB_SOURCE/server.py" \
  --host 127.0.0.1 --port 8081 \
  --credentials-file "$CREDENTIALS_FILE"
```

The credential file must remain outside Jupyter's served tree and the repository, in an owned directory with mode 0700; the owned regular file must have mode 0600. Omit `--credentials-file` when credentials are supplied only through the server environment. Retain the trailing slash on `/proxy/8081/`. Verify anonymous rejection, authenticated assets, a real decision, and notebook WebSockets after startup.

Detached app processes do not survive notebook restart or replacement. Retain the operator's private recovery backup outside the ephemeral pod until a durable storage and startup lifecycle is configured; the workshop and agent-side recovery copies must not be discarded just because acceptance passed. The current workshop blocks the alternate gateway port, so do not switch its Service targetPort to 8090 or repeat that routing experiment.

The Kubernetes gateway and session helpers below remain experimental alternatives for environments whose network policies explicitly support their routes; they are not the current workshop deployment path.

The `workshop.py` stdlib Python helper creates a persistent CPU Deployment with the demo server and an Nginx gateway. It keeps the notebook and GPU pods running. It requires `kubectl` already authenticated for the workshop namespace; it does not change ingress resources or create credentials.

The existing workshop Service keeps its ports and identity. A new `decision-lab-workshop` Service copies its original pod selector and ports. The gateway routes ordinary notebook paths, including WebSockets, to that copied Service. `/decision-lab/` reaches the demo after Jupyter `/api/me` accepts the incoming cookie or Authorization header. Anonymous requests redirect to the notebook login. The public Host is preserved for the demo's origin check. After the authentication subrequest, the gateway removes notebook cookies and Authorization before forwarding to the Python app. Each proxy location declares its own headers explicitly because Nginx does not inherit the server's header list when a location defines any `proxy_set_header`.

The helper accepts a workshop Service with one TCP HTTP port, targeting numeric port 8080 or a named HTTP port. It refuses incompatible ports and resources with conflicting ownership labels. The new resources are `Deployment/decision-lab`, `ConfigMap/decision-lab`, `Service/decision-lab` (for internal checks), and `Service/decision-lab-workshop`.

## Prepare and apply

Run from the `decision-lab` directory with your private namespace, Service name, and GPU endpoint:

```bash
python deploy/workshop.py prepare \
  --namespace "$WORKSHOP_NAMESPACE" \
  --workshop-service "$WORKSHOP_SERVICE" \
  --gpu-endpoint "$GPU_DECISIONS_URL"
python deploy/workshop.py apply
```

`prepare` makes no changes to the cluster. It saves the exact original Service and generated manifests in `./deploy-state.json`, with mode 0600, and refuses to overwrite an existing file. Keep this private file for rollback; do not commit it. Every command accepts `--state /private/path/deploy-state.json`. The model defaults to `Cloudflare/clef-flash`; use `--gpu-model` to change the served model name.

If existing namespace policy requires tenant identity metadata, pass repeated `--pod-label KEY=VALUE` arguments using verified labels for your own workshop identity. These labels are added only to the new pod template. The helper forbids `app` and `app.kubernetes.io/*` overrides and never changes network policy or adopts another application's role. If the namespace still blocks the new pod, obtain the required network grant before switching.

`apply` verifies resource ownership, creates the resources, and waits for the new Deployment. The app source is mounted from a ConfigMap; only the fixed runtime files are included. No environment files, credentials, evidence images, or model weights are bundled. GPU inference stays on the existing endpoint. OpenRouter comparisons enable themselves only if a separately managed `decision-lab-providers` Secret contains `OPENROUTER_API_KEY`. That reference is optional: GPU-only deployment works without the Secret. This helper never reads, writes, or prints credential values.

## Validate, then switch

Before switching, probe the internal `http://decision-lab:8080/` Service from a pod in the same namespace. Check notebook routing, anonymous `/decision-lab/api/health` redirect, authenticated app access, notebook WebSockets, and an authenticated decision request. Readiness alone proves that the local app and gateway are listening; it does not prove model health or successful authentication. Keep browser cookies and tokens out of source files and logs.

```bash
python deploy/workshop.py switch
```

`switch` requires the Deployment to be ready, then runs a connectivity preflight inside its app container: the local gateway must return HTTP 200 from the notebook `/api` route without following redirects, and the app pod must open a TCP connection to its configured GPU endpoint. A failed check prevents the Service change. This does not replace authenticated browser and model-inference validation or prove that ingress policy permits the new pod. The helper then changes only the original workshop Service selector, checking the original Service UID, unchanged ports and selector, and current resource version. When ingress and namespace routing permit access, the intended app path is the workshop's existing origin plus `/decision-lab/`. Notebook URLs stay at the same origin. Existing WebSocket connections may reconnect as endpoints update. Deployment readiness alone is insufficient evidence to switch: it does not validate the public route.

## Roll back

```bash
python deploy/workshop.py rollback
```

Rollback restores only the saved original selector, with the same identity/concurrency guards. It leaves the CPU Deployment and its Services for inspection and does not touch GPU or notebook workloads. To make a new source release, preserve the old state, generate a fresh prepared manifest while original routing is restored, then repeat apply, validation, and switch. Do not use a second `prepare` to snapshot an already switched gateway as the original notebook destination.

The gateway reuses Jupyter's existing authentication and does not add a second login or contain login credentials. A Jupyter `/api/me` configuration that permits anonymous access is unsuitable: validate rejection before switching.

## Existing notebook session

The experimental `session.py` alternative supervises the same app and gateway inside the existing notebook pod. It may help where a separate pod cannot reach the notebook or GPU, but does not establish that ingress can reach the gateway's port. It does not change network policy, Kubernetes resources, the notebook process, or its original port. Provide an executable Nginx binary or a wrapper that forwards its arguments, the application source directory, and a private runtime directory:

```bash
python deploy/session.py start \
  --prefix "$DECISION_LAB_RUNTIME" \
  --nginx "$NGINX_EXECUTABLE" \
  --app-dir "$DECISION_LAB_SOURCE" \
  --gpu-endpoint "$GPU_DECISIONS_URL"
python deploy/session.py status --prefix "$DECISION_LAB_RUNTIME"
python deploy/session.py stop --prefix "$DECISION_LAB_RUNTIME"
```

The app binds only to `127.0.0.1:8081`; the authenticated gateway listens on port 8090 and forwards ordinary notebook requests to `127.0.0.1:8080`. It reuses the same auth and WebSocket configuration as the Deployment. Provider keys are inherited from the process environment and are never saved in generated configuration or status. The GPU endpoint can also come from the `GPU_DECISIONS_URL` environment variable. Runtime configuration, logs, and status files are private to the pod filesystem.

The detached supervisor holds a singleton lock and restarts its two child processes with bounded backoff. `stop` verifies the supervisor identity before signalling it and terminates only its own app/gateway children. This survives a Jupyter kernel disconnect, but **does not survive notebook pod replacement or restart**; use a supported platform startup hook if available. Source files on persistent storage alone do not restart the processes.

The session helper does not switch ingress. The current deployment uses the app on loopback port 8081 through the verified Jupyter Server Proxy route and does not require this helper's alternate gateway. Leave the workshop Service on port 8080 and targetPort 8080; the current workshop does not permit gateway port 8090. Session hosting does not change those network restrictions.
