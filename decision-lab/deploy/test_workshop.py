import copy
import json
import re
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import workshop


ORIGINAL = {"apiVersion": "v1", "kind": "Service", "metadata": {
    "name": "notebook", "namespace": "example", "uid": "service-uid", "resourceVersion": "1"},
    "spec": {"selector": {"app": "notebook", "workspace": "example"},
             "ports": [{"port": 8080, "targetPort": 8080, "protocol": "TCP"}]}}


class WorkshopTests(unittest.TestCase):
    def state(self):
        return {"version": 1, "namespace": "example", "workshopService": "notebook",
                "originalService": copy.deepcopy(ORIGINAL), "resources": []}

    def test_generated_resources_preserve_notebook_and_have_no_credentials(self):
        original = copy.deepcopy(ORIGINAL)
        resources = workshop.manifests("example", original, "http://gpu:8000/v1/systemone", "Cloudflare/clef-flash")
        self.assertEqual(original, ORIGINAL)
        upstream, service, config, deployment = resources
        self.assertEqual(upstream["spec"]["selector"], ORIGINAL["spec"]["selector"])
        self.assertEqual(upstream["spec"]["ports"], ORIGINAL["spec"]["ports"])
        self.assertEqual(service["spec"]["selector"], workshop.POD_SELECTOR)
        containers = deployment["spec"]["template"]["spec"]["containers"]
        secret = next(env for env in containers[0]["env"] if env["name"] == "OPENROUTER_API_KEY")
        self.assertTrue(secret["valueFrom"]["secretKeyRef"]["optional"])
        self.assertNotIn("value", secret)
        self.assertFalse(deployment["spec"]["template"]["spec"]["automountServiceAccountToken"])
        self.assertLess(len(json.dumps(config).encode()), 900_000)
        self.assertEqual(set(config["data"]), {path.replace("/", "__") for path in workshop.SOURCE_FILES} | {"gateway.conf"})
        nginx = config["data"]["gateway.conf"]
        self.assertNotIn("@@NOTEBOOK_UPSTREAM@@", nginx)
        self.assertIn("auth_request /_decision_lab_auth;", nginx)
        self.assertIn("decision-lab-workshop.example.svc.cluster.local:8080/api/me", nginx)

    def test_incompatible_original_port_is_rejected(self):
        original = copy.deepcopy(ORIGINAL)
        original["spec"]["ports"][0]["targetPort"] = 8888
        with self.assertRaises(workshop.DeployError):
            workshop.manifests("example", original, "http://gpu:8000/v1/systemone", "clef")

    def test_each_proxy_location_explicitly_preserves_host_and_auth_is_isolated(self):
        nginx = (workshop.APP_ROOT / "deploy/gateway.conf").read_text()
        self.assertRegex(nginx, r"server\s*\{[^{}]*absolute_redirect\s+off;")
        self.assertIn("return 302 /login?next=%2Fdecision-lab%2F;", nginx)
        def headers(location):
            block = re.search(r"location " + re.escape(location) + r"\s*\{([^}]+)\}", nginx).group(1)
            return dict(re.findall(r"^\s*proxy_set_header\s+(\S+)\s+([^;]+);", block, re.MULTILINE))
        auth = headers("= /_decision_lab_auth")
        notebook = headers("/")
        app = headers("/decision-lab/")
        # Any local proxy_set_header disables inheritance of the server's list.
        # All three locations must carry the public host explicitly.
        for selected in (auth, notebook, app):
            self.assertEqual(selected["Host"], "$http_host")
            self.assertEqual(selected["X-Forwarded-Host"], "$http_host")
            self.assertEqual(selected["X-Forwarded-Proto"], "$http_x_forwarded_proto")
        for selected in (auth, notebook):
            self.assertEqual(selected["Authorization"], "$http_authorization")
            self.assertEqual(selected["Cookie"], "$http_cookie")
        self.assertEqual(app["Authorization"], '""')
        self.assertEqual(app["Cookie"], '""')
        self.assertEqual(notebook["Upgrade"], "$http_upgrade")
        self.assertEqual(notebook["Connection"], "$decision_lab_connection")

    def test_named_original_port_is_mirrored(self):
        original = copy.deepcopy(ORIGINAL)
        original["spec"]["ports"][0]["targetPort"] = "notebook-http"
        resources = workshop.manifests("example", original, "http://gpu:8000/v1/systemone", "clef")
        gateway = resources[-1]["spec"]["template"]["spec"]["containers"][1]
        self.assertEqual(gateway["ports"], [{"name": "notebook-http", "containerPort": 8080}])

    def test_tenant_labels_only_affect_the_pod_template(self):
        labels = workshop.parse_pod_labels(["student=example", "awp-student-number=example"])
        resources = workshop.manifests("example", ORIGINAL, "http://gpu:8000/v1/systemone", "clef", labels)
        deployment = resources[-1]
        self.assertEqual(deployment["spec"]["template"]["metadata"]["labels"],
                         {**workshop.LABELS, **workshop.POD_SELECTOR, **labels})
        self.assertEqual(deployment["spec"]["selector"]["matchLabels"], workshop.POD_SELECTOR)
        for resource in resources:
            self.assertNotIn("student", resource["metadata"]["labels"])

    def test_pod_labels_cannot_impersonate_application_roles(self):
        for value in ("app=workspace", "app.kubernetes.io/name=vllm", "app.kubernetes.io/component=notebook",
                      "bad key=value", "prefix./key=value", "key=value with spaces", "key=" + "x" * 64,
                      "/name=value", "prefix//name=value", "no-equals"):
            with self.subTest(value=value), self.assertRaises(workshop.DeployError):
                workshop.parse_pod_labels([value])
        with self.assertRaises(workshop.DeployError):
            workshop.parse_pod_labels(["student=one", "student=two"])

    @patch("workshop.get")
    def test_unowned_existing_resource_is_rejected(self, get):
        get.return_value = {"metadata": {"labels": {"app.kubernetes.io/name": "something-else"}}}
        with self.assertRaises(workshop.DeployError):
            workshop.guard_owned("example", {"kind": "Deployment", "metadata": {"name": "decision-lab"}})

    @patch("workshop.kubectl", return_value="ok")
    @patch("workshop.get", return_value=ORIGINAL)
    def test_switch_only_changes_selector_with_concurrency_guards(self, get, kubectl):
        workshop.change_selector(self.state(), rollback=False)
        preflight = kubectl.call_args_list[-2].args
        self.assertEqual(preflight[1:8], ("exec", "deployment/decision-lab", "-c", "app", "--", "python", "-c"))
        self.assertIn("http://127.0.0.1:8080/api", preflight[-1])
        self.assertIn("socket.create_connection", preflight[-1])
        patch_args = kubectl.call_args.args
        self.assertEqual(patch_args[1:5], ("patch", "service", "notebook", "--type=json"))
        operations = json.loads(patch_args[-1])
        self.assertEqual(operations[0], {"op": "test", "path": "/metadata/resourceVersion", "value": "1"})
        self.assertEqual(operations[-1], {"op": "replace", "path": "/spec/selector", "value": workshop.POD_SELECTOR})
        self.assertEqual([x["path"] for x in operations if x["op"] != "test"], ["/spec/selector"])

    @patch("workshop.kubectl")
    @patch("workshop.get", return_value=ORIGINAL)
    def test_failed_upstream_preflight_prevents_live_selector_patch(self, get, kubectl):
        kubectl.side_effect = ["deployment is ready", workshop.DeployError("Preflight failed: network blocked")]
        with self.assertRaisesRegex(workshop.DeployError, "network blocked"):
            workshop.change_selector(self.state(), rollback=False)
        self.assertEqual(kubectl.call_count, 2)
        self.assertFalse(any(call.args[1] == "patch" for call in kubectl.call_args_list))

    @patch("workshop.kubectl")
    @patch("workshop.get")
    def test_outside_selector_change_cannot_be_overwritten(self, get, kubectl):
        current = copy.deepcopy(ORIGINAL)
        current["spec"]["selector"] = {"app": "another-deployment"}
        get.return_value = current
        with self.assertRaises(workshop.DeployError):
            workshop.change_selector(self.state(), rollback=False)
        kubectl.assert_not_called()

    @patch("workshop.kubectl", return_value="ok")
    @patch("workshop.get")
    def test_rollback_restores_original_selector_without_waiting_on_app(self, get, kubectl):
        current = copy.deepcopy(ORIGINAL)
        current["spec"]["selector"] = workshop.POD_SELECTOR
        get.return_value = current
        workshop.change_selector(self.state(), rollback=True)
        self.assertEqual(kubectl.call_count, 1)
        self.assertEqual(json.loads(kubectl.call_args.args[-1])[-1]["value"], ORIGINAL["spec"]["selector"])

    def test_backup_cannot_overwrite_an_existing_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            workshop.write_state(path, self.state())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(workshop.DeployError):
                workshop.write_state(path, {"replacement": True})
            self.assertEqual(workshop.read_state(path), self.state())


if __name__ == "__main__":
    unittest.main()
