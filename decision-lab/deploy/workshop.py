#!/usr/bin/env python3
"""Stage and switch a Decision Lab gateway without changing notebook/GPU pods."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

APP_ROOT = Path(__file__).resolve().parents[1]
NAME = "decision-lab"
UPSTREAM_NAME = "decision-lab-workshop"
LABELS = {"app.kubernetes.io/name": NAME,
          "app.kubernetes.io/managed-by": "decision-lab-deployer"}
POD_SELECTOR = {"app.kubernetes.io/name": NAME,
                "app.kubernetes.io/component": "gateway"}
SOURCE_FILES = ("server.py", "server/__init__.py", "server/providers.py",
                "public/index.html", "public/app.js", "public/style.css",
                "public/scenarios.js", "public/scenarios.css", "public/benchmark.json")


class DeployError(Exception):
    pass


def kubectl(namespace: str, *args: str, payload: dict | None = None) -> str:
    command = ["kubectl", "--namespace", namespace, *args]
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, check=False)
    if result.returncode:
        raise DeployError(f"kubectl {' '.join(args[:3])} failed: {result.stderr.strip()}")
    return result.stdout


def get(namespace: str, kind: str, name: str, *, optional: bool = False) -> dict | None:
    args = ["get", kind, name, "-o", "json"]
    if optional:
        args.append("--ignore-not-found")
    raw = kubectl(namespace, *args)
    return json.loads(raw) if raw.strip() else None


def validate_name(value: str) -> str:
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value):
        raise DeployError("Namespace and Service names must be valid DNS labels")
    return value


def validate_endpoint(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.fragment
                or any(c.isspace() or ord(c) < 32 for c in value)):
            raise ValueError()
        parsed.port
    except ValueError:
        raise DeployError("--gpu-endpoint must be a complete HTTP(S) URL without embedded credentials") from None
    return value


def parse_pod_labels(values: list[str]) -> dict[str, str]:
    """Optional tenant metadata, never an application-role or managed selector."""
    result = {}
    token = r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?"
    for value in values:
        key, separator, label = value.partition("=")
        if not separator or not key:
            raise DeployError("--pod-label must have the form KEY=VALUE")
        if key == "app" or key.startswith("app.kubernetes.io/") or key in LABELS or key in POD_SELECTOR:
            raise DeployError("--pod-label cannot change application-role or managed labels")
        if key.count("/") > 1:
            raise DeployError("--pod-label key is not a valid Kubernetes label key")
        prefix, _, name = key.rpartition("/")
        if prefix:
            if len(prefix) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in prefix.split(".")):
                raise DeployError("--pod-label prefix must be a DNS subdomain")
        if key.startswith("/") or not re.fullmatch(token, name):
            raise DeployError("--pod-label key is not a valid Kubernetes label key")
        if label and not re.fullmatch(token, label):
            raise DeployError("--pod-label value is not a valid Kubernetes label value")
        if key in result and result[key] != label:
            raise DeployError("--pod-label contains conflicting values for the same key")
        result[key] = label
    return result


def metadata(namespace: str, name: str = NAME) -> dict:
    return {"name": name, "namespace": namespace, "labels": dict(LABELS)}


def guard_owned(namespace: str, resource: dict) -> None:
    existing = get(namespace, resource["kind"], resource["metadata"]["name"], optional=True)
    if existing is None:
        return
    labels = existing["metadata"].get("labels", {})
    if any(labels.get(key) != value for key, value in LABELS.items()):
        raise DeployError(f"Refusing to overwrite unowned {resource['kind']}/{resource['metadata']['name']}")


def manifests(namespace: str, workshop: dict, gpu_endpoint: str, model: str,
              pod_labels: dict[str, str] | None = None) -> list[dict]:
    extra_labels = parse_pod_labels([f"{key}={value}" for key, value in (pod_labels or {}).items()])
    spec = workshop.get("spec", {})
    selector, ports = spec.get("selector"), spec.get("ports")
    if not isinstance(selector, dict) or not selector or not isinstance(ports, list) or not ports:
        raise DeployError("Workshop Service must have a nonempty selector and ports")
    if selector == POD_SELECTOR:
        raise DeployError("Workshop Service already targets Decision Lab; use its original saved state")
    # Selector-only switching must leave every existing Service port functional.
    # This small gateway handles a single HTTP port; it does not guess at others.
    if len(ports) != 1 or ports[0].get("protocol", "TCP") != "TCP":
        raise DeployError("This gateway requires a workshop Service with one TCP HTTP port")
    target = ports[0].get("targetPort", ports[0]["port"])
    if not isinstance(target, str) and target != 8080:
        raise DeployError("Selector-only switching requires targetPort 8080 or a named HTTP targetPort")
    upstream = f"{UPSTREAM_NAME}.{namespace}.svc.cluster.local:{ports[0]['port']}"
    gateway = (APP_ROOT / "deploy/gateway.conf").read_text().replace("@@NOTEBOOK_UPSTREAM@@", upstream)
    source = {path.replace("/", "__"): (APP_ROOT / path).read_text() for path in SOURCE_FILES}
    source["gateway.conf"] = gateway
    config = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata(namespace), "data": source}
    if len(json.dumps(config).encode()) > 900_000:
        raise DeployError("Runtime ConfigMap exceeds the conservative 900 KB limit")
    source_items = [{"key": path.replace("/", "__"), "path": path} for path in SOURCE_FILES]
    copied_ports = [{key: value for key, value in port.items() if key != "nodePort"} for port in ports]
    upstream_service = {"apiVersion": "v1", "kind": "Service", "metadata": metadata(namespace, UPSTREAM_NAME),
                        "spec": {"type": "ClusterIP", "selector": selector, "ports": copied_ports}}
    gateway_service = {"apiVersion": "v1", "kind": "Service", "metadata": metadata(namespace),
                       "spec": {"type": "ClusterIP", "selector": POD_SELECTOR,
                                "ports": [{"name": "http", "port": 8080, "targetPort": 8080, "protocol": "TCP"}]}}
    security = {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]}, "runAsNonRoot": True}
    app = {
        "name": "app", "image": "python:3.12-slim", "imagePullPolicy": "IfNotPresent",
        "workingDir": "/app", "command": ["python", "server.py", "--host", "0.0.0.0", "--port", "8081"],
        "ports": [{"name": "app", "containerPort": 8081}],
        "env": [{"name": "GPU_DECISIONS_URL", "value": gpu_endpoint},
                {"name": "GPU_MODEL_ID", "value": model},
                {"name": "GPU_MODEL_LABEL", "value": "Akamai GPU · Clef FP8"},
                {"name": "PYTHONDONTWRITEBYTECODE", "value": "1"},
                {"name": "PYTHONUNBUFFERED", "value": "1"},
                {"name": "OPENROUTER_API_KEY", "valueFrom": {"secretKeyRef": {
                    "name": "decision-lab-providers", "key": "OPENROUTER_API_KEY", "optional": True}}}],
        "securityContext": dict(security, runAsUser=10001, runAsGroup=10001),
        "resources": {"requests": {"cpu": "100m", "memory": "64Mi"},
                      "limits": {"cpu": "1", "memory": "256Mi"}},
        "volumeMounts": [{"name": "source", "mountPath": "/app", "readOnly": True}],
        "readinessProbe": {"httpGet": {"path": "/api/health", "port": 8081}, "periodSeconds": 3},
        "livenessProbe": {"httpGet": {"path": "/api/health", "port": 8081}, "periodSeconds": 15}}
    gateway_port = target if isinstance(target, str) else "http"
    gateway_container = {
        "name": "gateway", "image": "nginxinc/nginx-unprivileged:stable-alpine", "imagePullPolicy": "IfNotPresent",
        "command": ["nginx", "-g", "daemon off;"],
        "ports": [{"name": gateway_port, "containerPort": 8080}],
        "securityContext": dict(security, runAsUser=101, runAsGroup=101),
        "resources": {"requests": {"cpu": "50m", "memory": "32Mi"},
                      "limits": {"cpu": "250m", "memory": "128Mi"}},
        "volumeMounts": [{"name": "gateway", "mountPath": "/etc/nginx/conf.d/default.conf", "subPath": "gateway.conf", "readOnly": True},
                         {"name": "nginx-tmp", "mountPath": "/tmp"}],
        "readinessProbe": {"tcpSocket": {"port": 8080}, "periodSeconds": 3},
        "livenessProbe": {"tcpSocket": {"port": 8080}, "periodSeconds": 15}}
    deployment = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": metadata(namespace), "spec": {
        "replicas": 1, "revisionHistoryLimit": 2, "selector": {"matchLabels": POD_SELECTOR},
        "strategy": {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": 1, "maxUnavailable": 0}},
        "template": {"metadata": {"labels": {**LABELS, **POD_SELECTOR, **extra_labels},
            "annotations": {"decision-lab/source-sha256": hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()}},
            "spec": {"automountServiceAccountToken": False,
                "securityContext": {"fsGroup": 101, "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [app, gateway_container], "volumes": [
                    {"name": "source", "configMap": {"name": NAME, "items": source_items}},
                    {"name": "gateway", "configMap": {"name": NAME, "items": [{"key": "gateway.conf", "path": "gateway.conf"}]}},
                    {"name": "nginx-tmp", "emptyDir": {}}]}}}}
    return [upstream_service, gateway_service, config, deployment]


def write_state(path: Path, state: dict) -> None:
    # Never destroy an earlier backup, including through a symlink.
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise DeployError(f"State file already exists: {path}; preserve it for rollback") from None
    with os.fdopen(descriptor, "w") as stream:
        json.dump(state, stream, indent=2)
        stream.write("\n")


def read_state(path: Path) -> dict:
    state = json.loads(path.read_text())
    if state.get("version") != 1:
        raise DeployError("Unsupported deployment state version")
    validate_name(state["namespace"])
    validate_name(state["workshopService"])
    original = state["originalService"]
    if original["metadata"]["name"] != state["workshopService"] or original["metadata"]["namespace"] != state["namespace"]:
        raise DeployError("State Service identity does not match its namespace/name")
    return state


def verify_original(state: dict) -> dict:
    current = get(state["namespace"], "service", state["workshopService"])
    original = state["originalService"]
    if current["metadata"]["uid"] != original["metadata"]["uid"]:
        raise DeployError("Workshop Service was replaced; refusing to change a different resource")
    if current["spec"].get("ports") != original["spec"].get("ports"):
        raise DeployError("Workshop Service ports changed since preparation; refusing selector switch")
    return current


def verify_upstream_connectivity(namespace: str) -> None:
    """Check the new pod's actual network path before changing live routing."""
    probe = '''import os,socket,sys,urllib.parse,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
try:
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open('http://127.0.0.1:8080/api',timeout=8) as response:
        if response.status != 200: raise ValueError('unexpected status')
except Exception:
    sys.exit('Preflight failed: gateway cannot reach the notebook API with HTTP 200')
try:
    endpoint=urllib.parse.urlsplit(os.environ.get('GPU_DECISIONS_URL',''))
    if endpoint.scheme not in ('http','https') or not endpoint.hostname:
        raise ValueError('invalid GPU endpoint')
    with socket.create_connection((endpoint.hostname,endpoint.port or (443 if endpoint.scheme=='https' else 80)),timeout=8):
        pass
except Exception:
    sys.exit('Preflight failed: app pod cannot open a TCP connection to the configured GPU endpoint')
print('Gateway notebook upstream and GPU TCP connectivity verified.')
'''
    print(kubectl(namespace, "exec", "deployment/decision-lab", "-c", "app", "--", "python", "-c", probe).strip())


def change_selector(state: dict, *, rollback: bool) -> None:
    namespace = state["namespace"]
    current = verify_original(state)
    original_selector = state["originalService"]["spec"]["selector"]
    expected = POD_SELECTOR if rollback else original_selector
    desired = original_selector if rollback else POD_SELECTOR
    selector = current["spec"].get("selector")
    if selector == desired:
        print("Workshop Service already has the requested selector.")
        return
    if selector != expected:
        raise DeployError("Workshop Service selector changed outside this deployment; refusing to overwrite it")
    if not rollback:
        for resource in state["resources"]:
            guard_owned(namespace, resource)
            if get(namespace, resource["kind"], resource["metadata"]["name"], optional=True) is None:
                raise DeployError("Apply the prepared resources before switching")
        print(kubectl(namespace, "rollout", "status", "deployment/decision-lab", "--timeout=180s").strip())
        verify_upstream_connectivity(namespace)
    patch = [
        {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
        {"op": "test", "path": "/spec/selector", "value": expected},
        {"op": "replace", "path": "/spec/selector", "value": desired}]
    print(kubectl(namespace, "patch", "service", state["workshopService"], "--type=json", "-p", json.dumps(patch)).strip())
    print("Original notebook routing restored." if rollback else "Workshop gateway enabled; app is at /decision-lab/.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Read original Service and save exact backup plus manifests; makes no cluster changes")
    prepare.add_argument("--namespace", required=True)
    prepare.add_argument("--workshop-service", required=True)
    prepare.add_argument("--gpu-endpoint", required=True)
    prepare.add_argument("--gpu-model", default="Cloudflare/clef-flash")
    prepare.add_argument("--pod-label", action="append", default=[], metavar="KEY=VALUE",
                         help="Repeat for tenant identity labels required by existing namespace policy; application-role labels are forbidden")
    for command in (prepare, commands.add_parser("apply", help="Create/update the owned CPU app resources; existing ingress is unchanged"),
                    commands.add_parser("switch", help="After checks, point the existing workshop Service selector at the ready gateway"),
                    commands.add_parser("rollback", help="Restore only the original Service selector; leaves app resources for inspection")):
        command.add_argument("--state", type=Path, default=Path("deploy-state.json"))
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            namespace, service = validate_name(args.namespace), validate_name(args.workshop_service)
            if service in {NAME, UPSTREAM_NAME}:
                raise DeployError("Workshop Service name collides with a managed Decision Lab resource")
            endpoint = validate_endpoint(args.gpu_endpoint)
            original = get(namespace, "service", service)
            resources = manifests(namespace, original, endpoint, args.gpu_model, parse_pod_labels(args.pod_label))
            for resource in resources:
                guard_owned(namespace, resource)
            state = {"version": 1, "namespace": namespace, "workshopService": service,
                     "originalService": original, "resources": resources}
            write_state(args.state, state)
            print(f"Prepared {len(resources)} resources and exact Service backup in {args.state}; no cluster changes made.")
        else:
            state = read_state(args.state)
            if args.command == "apply":
                verify_original(state)
                for resource in state["resources"]:
                    guard_owned(state["namespace"], resource)
                print(kubectl(state["namespace"], "apply", "-f", "-", payload={"apiVersion": "v1", "kind": "List", "items": state["resources"]}).strip())
                print(kubectl(state["namespace"], "rollout", "status", "deployment/decision-lab", "--timeout=180s").strip())
                print("Existing workshop routing is unchanged. Validate decision-lab:8080 before switch.")
            else:
                change_selector(state, rollback=args.command == "rollback")
    except (DeployError, KeyError, ValueError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
