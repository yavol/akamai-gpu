#!/usr/bin/env python3
"""Six modest live API checks. Saves real latency/results, never credentials.

Run from project root: python scripts/probe_providers.py
Requires OPENROUTER_API_KEY. These are sanity checks, not a performance benchmark.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.providers import execute_decision, ProviderError


def red_png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes((255, 0, 0)) * 128 for _ in range(128))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', 128, 128, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def main():
    png = red_png()
    image = ['Identify the color in the image.', {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode()}}]
    questions = {'color': {'type': 'choice', 'instructions': 'What color is shown?', 'criteria': {'red': 'Red', 'blue': 'Blue', 'green': 'Green'}}}
    checks = [('clef', 'text'), ('jev', 'text'), ('luna', 'text'), ('luna-decisions', 'text'), ('clef', 'image'), ('luna', 'image')]
    report = {'recordedAt': datetime.now(timezone.utc).isoformat(),
              'methodology': 'Single sequential request per provider and modality. Server wall time includes network, routing, inference, and response parsing. No warmup, no local cache, no injected delay, no retries. This small sanity probe is not a statistically reliable model benchmark.',
              'image': {'description': '128×128 solid RGB red PNG', 'sha256': hashlib.sha256(png).hexdigest()},
              'jevImageSupport': 'Text only; rejected locally rather than allowing image data to be interpreted as text.',
              'clefRouting': 'Cloudflare pinned. PrimeIntellect failed two separate red-image checks during development; Cloudflare passed.',
              'results': []}
    for provider, mode in checks:
        entry = {'provider': provider, 'mode': mode, 'expected': 'red'}
        try:
            result = execute_decision(provider, image if mode == 'image' else 'The color is red.', questions)
            entry.update(result=result, success=result['answers']['color']['choice'] == 'red')
        except ProviderError as error:
            entry.update(success=False, error=error.as_dict())
        report['results'].append(entry)
        print(json.dumps({'provider': provider, 'mode': mode, 'success': entry['success'], 'latencyMs': entry.get('result', {}).get('latencyMs'), 'error': entry.get('error')}), flush=True)
    destination = ROOT / 'evidence' / 'provider-probes.json'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Saved {destination}')
    return 0 if all(x['success'] for x in report['results']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
