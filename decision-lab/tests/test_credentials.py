import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('decision_lab_http', ROOT / 'server.py')
http = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http)


class CredentialsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.directory.chmod(0o700)
        self.path = self.directory / 'credentials.json'
        self.environment = patch.dict(os.environ, {'OPENROUTER_API_KEY': 'existing'}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def write(self, content, mode=0o600):
        self.path.write_text(content)
        self.path.chmod(mode)

    def test_private_file_loads_only_present_keys_and_catalog_reads_them(self):
        self.write(json.dumps({'OPENROUTER_API_KEY': 'test-router', 'OPENAI_API_KEY': 'test-openai', 'GPU_API_KEY': 'test-gpu'}))
        http.load_credentials_file(self.path)
        self.assertEqual(os.environ['OPENROUTER_API_KEY'], 'test-router')
        self.assertEqual(os.environ['OPENAI_API_KEY'], 'test-openai')
        self.assertEqual(os.environ['GPU_API_KEY'], 'test-gpu')
        self.assertTrue(next(row for row in http.catalog() if row['id'] == 'clef')['available'])
        self.assertNotIn('test-router', json.dumps(http.catalog()))

    def test_invalid_documents_do_not_partially_modify_environment_or_echo_values(self):
        for document in ('not-json-test-secret', '[]', '{"OPENROUTER_API_KEY":"test-secret","OTHER":"value"}',
                         '{"OPENROUTER_API_KEY":"test-secret","GPU_API_KEY":123}',
                         '{"OPENROUTER_API_KEY":"test-secret","OPENROUTER_API_KEY":"duplicate"}',
                         '{"OPENROUTER_API_KEY":"test-secret","GPU_API_KEY":"bad\\u0000value"}',
                         '{"OPENROUTER_API_KEY":"test-secret","GPU_API_KEY":"bad\\ud800value"}'):
            with self.subTest(document=document):
                self.write(document)
                with self.assertRaises(http.CredentialsFileError) as error:
                    http.load_credentials_file(self.path)
                self.assertNotIn('test-secret', str(error.exception))
                self.assertEqual(dict(os.environ), {'OPENROUTER_API_KEY': 'existing'})

    def test_file_permissions_must_be_0600(self):
        for mode in (0o644, 0o640, 0o604, 0o700, 0o400):
            with self.subTest(mode=oct(mode)):
                self.write('{}', mode)
                with self.assertRaises(http.CredentialsFileError):
                    http.load_credentials_file(self.path)

    def test_parent_must_be_private_and_owned_by_current_user(self):
        self.write('{}')
        self.directory.chmod(0o755)
        with self.assertRaises(http.CredentialsFileError):
            http.load_credentials_file(self.path)
        self.directory.chmod(0o700)
        with patch.object(http.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaises(http.CredentialsFileError):
                http.load_credentials_file(self.path)

    def test_symlink_file_is_rejected(self):
        target = self.directory / 'real.json'
        target.write_text('{}')
        target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(http.CredentialsFileError):
            http.load_credentials_file(self.path)

    def test_file_with_different_owner_is_rejected(self):
        self.write('{}')
        file_info = list(self.path.stat())
        file_info[4] = os.getuid() + 1
        with patch.object(http.os, 'fstat', side_effect=[self.directory.stat(), os.stat_result(file_info)]):
            with self.assertRaises(http.CredentialsFileError):
                http.load_credentials_file(self.path)

    def test_symlink_parent_is_rejected(self):
        self.write('{}')
        alias = self.directory / 'alias'
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(http.CredentialsFileError):
            http.load_credentials_file(alias / self.path.name)

    def test_nonregular_file_is_rejected_without_blocking(self):
        os.mkfifo(self.path, mode=0o600)
        with self.assertRaises(http.CredentialsFileError):
            http.load_credentials_file(self.path)


if __name__ == '__main__':
    unittest.main()
