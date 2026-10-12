import base64
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.providers import ProviderError, _post_json, catalog, execute_decision

QUESTIONS = {"color": {"type": "choice", "instructions": "What color?", "criteria": {"red": "Red", "blue": "Blue"}}}
RESULT = {"model": "cloudflare/clef-flash", "answers": {"color": {"choice": "red", "confidence": .8, "probabilities": {"red": .9, "blue": .1}}}, "usage": {"input_tokens": 30}, "id": "request-1", "provider": "Cloudflare"}
# Exact SGLang response shape from the live workshop endpoint. Native confidence
# is different from the selected option probability and must remain unchanged.
SGLANG_RESULT = {"model": "Cloudflare/clef-flash", "answers": {"color": {
    "type": "choice", "choice": "red", "confidence": 0.9898003633940933,
    "probabilities": {"red": 0.9949001816970466, "blue": 0.0050998183029534174}}},
    "usage": {"input_tokens": 132, "output_tokens": 0}}
TIMING = {"upstreamMs": 20, "headersMs": 19, "bodyMs": 1}
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 20).decode()
IMAGE_STATE = ["Read this image", {"type": "image_url", "image_url": {"url": PNG}}]


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"OPENROUTER_API_KEY": "unit-secret"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    @patch("server.providers._post_json", return_value=(RESULT, TIMING.copy()))
    def test_native_response_and_exact_model(self, post):
        result = execute_decision("clef", "red", QUESTIONS)
        url, payload, token, timeout = post.call_args.args
        self.assertEqual(url, "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(payload["model"], "cloudflare/clef-flash")
        self.assertEqual(payload["questions"], QUESTIONS)
        self.assertEqual(token, "unit-secret")
        self.assertEqual(result["answers"]["color"]["probabilities"], {"red": .9, "blue": .1})
        self.assertEqual(result["upstreamProvider"], "Cloudflare")
        self.assertNotIn("unit-secret", json.dumps(result))
        self.assertFalse(result["timing"]["cachedLocally"])

    @patch("server.providers._post_json", return_value=(RESULT, TIMING.copy()))
    def test_convenience_questions_are_converted(self, post):
        execute_decision("clef", "red", {"color": {"description": "What color?", "options": ["red", "blue"]}})
        self.assertEqual(post.call_args.args[1]["questions"]["color"]["criteria"], {"red": "red", "blue": "blue"})

    @patch("server.providers._post_json")
    def test_duplicate_choices_rejected_before_network(self, post):
        with self.assertRaises(ProviderError) as error:
            execute_decision("clef", "red", {"color": {"description": "What color?", "options": ["red", "red"]}})
        self.assertEqual(error.exception.status, 400)
        post.assert_not_called()

    @patch("server.providers._post_json")
    def test_jev_rejects_images_instead_of_stripping_them(self, post):
        with self.assertRaises(ProviderError) as error:
            execute_decision("jev", IMAGE_STATE, QUESTIONS)
        self.assertEqual(error.exception.code, "unsupported_modality")
        post.assert_not_called()

    @patch("server.providers._post_json")
    def test_remote_images_rejected(self, post):
        with self.assertRaises(ProviderError):
            execute_decision("clef", [{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}], QUESTIONS)
        post.assert_not_called()

    @patch("server.providers._post_json")
    def test_missing_credentials_is_explicit(self, post):
        os.environ.pop("OPENROUTER_API_KEY")
        with self.assertRaises(ProviderError) as error:
            execute_decision("clef", "red", QUESTIONS)
        self.assertEqual(error.exception.status, 503)
        post.assert_not_called()

    @patch("server.providers._post_json", side_effect=ProviderError("429", 429))
    def test_upstream_failure_never_retries_or_substitutes(self, post):
        with self.assertRaises(ProviderError):
            execute_decision("clef", "red", QUESTIONS)
        self.assertEqual(post.call_count, 1)

    @patch("server.providers._post_json")
    def test_invalid_choice_never_applied(self, post):
        post.return_value = ({"answers": {"color": {"choice": "purple"}}}, TIMING.copy())
        with self.assertRaises(ProviderError) as error:
            execute_decision("clef", "red", QUESTIONS)
        self.assertEqual(error.exception.code, "invalid_response")

    @patch("server.providers._post_json")
    def test_invalid_distribution_rejected(self, post):
        post.return_value = ({"answers": {"color": {"choice": "red", "probabilities": {"red": .9, "blue": .9}}}}, TIMING.copy())
        with self.assertRaises(ProviderError):
            execute_decision("clef", "red", QUESTIONS)

    @patch("server.providers._post_json")
    def test_luna_uses_same_questions_no_reasoning_and_no_invented_confidence(self, post):
        post.return_value = ({"choices": [{"finish_reason": "stop", "message": {"content": '{"answers":{"color":"red"}}'}}]}, TIMING.copy())
        result = execute_decision("luna", IMAGE_STATE, QUESTIONS)
        url, payload, _, _ = post.call_args.args
        self.assertEqual(url, "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(payload["reasoning"], {"effort": "none"})
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertEqual(payload["messages"][1]["content"][0]["type"], "text")
        self.assertEqual(payload["messages"][1]["content"][1], IMAGE_STATE[1])
        self.assertIsNone(result["answers"]["color"]["confidence"])
        self.assertIsNone(result["answers"]["color"]["probabilities"])

    @patch("server.providers._post_json")
    def test_truncated_chat_rejected(self, post):
        post.return_value = ({"choices": [{"finish_reason": "length", "message": {"content": '{"answers":{"color":"red"}}'}}]}, TIMING.copy())
        with self.assertRaises(ProviderError):
            execute_decision("luna", "red", QUESTIONS)

    @patch("server.providers._post_json", return_value=(RESULT, TIMING.copy()))
    def test_custom_gpu_endpoint_is_server_config_only(self, post):
        os.environ.update({"GPU_DECISIONS_URL": "http://127.0.0.1:9999/v1/systemone", "GPU_MODEL_ID": "own-clef", "GPU_API_KEY": "gpu-secret"})
        execute_decision("gpu", "red", QUESTIONS)
        self.assertEqual(post.call_args.args[0], os.environ["GPU_DECISIONS_URL"])
        self.assertEqual(post.call_args.args[1]["model"], "own-clef")
        self.assertEqual(post.call_args.args[2], "gpu-secret")

    @patch("server.providers._post_json", return_value=(SGLANG_RESULT, TIMING.copy()))
    def test_gpu_uses_deployed_model_default_and_native_image_contract(self, post):
        os.environ["GPU_DECISIONS_URL"] = "http://gpu-service:8000/v1/systemone"
        result = execute_decision("gpu", IMAGE_STATE, QUESTIONS)
        payload = post.call_args.args[1]
        self.assertEqual(payload["model"], "Cloudflare/clef-flash")
        self.assertEqual(payload["state"], "Read this image")
        self.assertEqual(payload["images"], [PNG])
        self.assertNotIn(PNG, payload["state"])
        self.assertEqual(payload["questions"], QUESTIONS)
        self.assertNotIn("provider", payload)
        self.assertEqual(result["answers"], SGLANG_RESULT["answers"])
        self.assertEqual(result["usage"], {"input_tokens": 132, "output_tokens": 0})
        self.assertEqual(result["model"], "Cloudflare/clef-flash")
        self.assertEqual(result["timing"]["upstreamMs"], 20)
        self.assertNotIn("inferenceMs", result["timing"])
        self.assertNotIn("inferenceMs", result)

    @patch("server.providers._post_json", return_value=(SGLANG_RESULT, TIMING.copy()))
    def test_gpu_separates_all_images_and_keeps_text_order(self, post):
        os.environ["GPU_DECISIONS_URL"] = "http://gpu-service:8000/v1/systemone"
        second = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"1" * 20).decode()
        state = [IMAGE_STATE[1], {"type": "text", "text": "First observation"},
                 {"type": "image_url", "image_url": {"url": second}}, "Second observation"]
        execute_decision("gpu", state, QUESTIONS)
        payload = post.call_args.args[1]
        self.assertEqual(payload["state"], "First observation\n\nSecond observation")
        self.assertEqual(payload["images"], [PNG, second])

    @patch("server.providers._post_json", return_value=(SGLANG_RESULT, TIMING.copy()))
    def test_gpu_image_only_input_does_not_turn_image_bytes_into_text(self, post):
        os.environ["GPU_DECISIONS_URL"] = "http://gpu-service:8000/v1/systemone"
        execute_decision("gpu", [IMAGE_STATE[1]], QUESTIONS)
        payload = post.call_args.args[1]
        self.assertEqual(payload["state"], "")
        self.assertEqual(payload["images"], [PNG])

    @patch("server.providers._post_json", return_value=(RESULT, TIMING.copy()))
    def test_openrouter_images_keep_the_openrouter_state_contract(self, post):
        execute_decision("clef", IMAGE_STATE, QUESTIONS)
        payload = post.call_args.args[1]
        self.assertEqual(payload["state"], IMAGE_STATE)
        self.assertNotIn("images", payload)

    @patch("server.providers._post_json")
    def test_invalid_gpu_endpoint_is_unavailable_and_never_requested(self, post):
        for url in ("", "file:///tmp/socket", "http://[broken", "http://host:bad/v1/systemone",
                    "http://host:99999/v1/systemone", "http://user:secret@host/v1/systemone",
                    "http://host/v1/systemone#fragment", "http://host/\npath"):
            with self.subTest(url=url):
                os.environ["GPU_DECISIONS_URL"] = url
                entry = next(row for row in catalog() if row["id"] == "gpu")
                self.assertFalse(entry["available"])
                with self.assertRaises(ProviderError) as error:
                    execute_decision("gpu", "red", QUESTIONS)
                self.assertEqual(error.exception.code, "not_configured")
        post.assert_not_called()

    def test_gpu_catalog_label_is_server_configurable(self):
        os.environ.update({"GPU_DECISIONS_URL": "http://gpu-service:8000/v1/systemone",
                           "GPU_MODEL_ID": "custom-clef", "GPU_MODEL_LABEL": "Workshop GPU"})
        entry = next(row for row in catalog() if row["id"] == "gpu")
        self.assertTrue(entry["configured"])
        self.assertEqual(entry["label"], "Workshop GPU")
        self.assertEqual(entry["model"], "custom-clef")

    def test_catalog_does_not_expose_secrets_or_endpoint(self):
        os.environ["GPU_DECISIONS_URL"] = "https://private-host/path"
        encoded = json.dumps(catalog())
        self.assertNotIn("unit-secret", encoded)
        self.assertNotIn("private-host", encoded)
        self.assertFalse(next(x for x in catalog() if x["id"] == "jev")["supportsImages"])

    @patch("server.providers.urllib.request.build_opener")
    def test_timeout_surfaces_as_gateway_timeout(self, opener):
        opener.return_value.open.side_effect = urllib.error.URLError(socket.timeout())
        with self.assertRaises(ProviderError) as error:
            _post_json("https://example.com", {}, "secret", 2)
        self.assertEqual(error.exception.status, 504)

    @patch("server.providers._post_json")
    def test_unknown_provider_cannot_select_arbitrary_model(self, post):
        with self.assertRaises(ProviderError):
            execute_decision("unknown/model", "red", QUESTIONS)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
