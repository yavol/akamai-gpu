import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('decision_lab_http_requests', ROOT / 'server.py')
http = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http)


class RequestInspectorHttpTests(unittest.TestCase):
    def request(self, payload):
        body = json.dumps(payload).encode()
        handler = http.Handler.__new__(http.Handler)
        handler.path = '/api/decide'
        handler.headers = {'Content-Type': 'application/json', 'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.send = Mock()
        handler.do_POST()
        return handler.send

    def test_boolean_opt_in_is_forwarded_and_defaults_off(self):
        for fields, expected in (({}, False), ({'includeRequest': False}, False), ({'includeRequest': True}, True)):
            with self.subTest(fields=fields), patch.object(http, 'execute_decision', return_value={'answers': {}}) as execute:
                send = self.request(dict(provider='jev', state='red', questions={}, **fields))
                self.assertEqual(execute.call_args.kwargs['include_request'], expected)
                send.assert_called_once_with(200, {'answers': {}})

    def test_nonboolean_opt_in_is_rejected_before_inference(self):
        for value in (None, 0, 1, 'true', [], {}):
            with self.subTest(value=value), patch.object(http, 'execute_decision') as execute:
                send = self.request({'includeRequest': value})
                send.assert_called_once_with(400, {'error': 'includeRequest must be a boolean.'})
                execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
