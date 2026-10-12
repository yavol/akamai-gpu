#!/usr/bin/env python3
"""Reproducible interleaved benchmark over frozen browser observations.

Default: six observations × three providers × three repeats = 54 real requests.
Expected answers are used only after inference for scoring, never in requests.
No warmup is discarded, and no artificial delay, retry, or fallback is added.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.providers import execute_decision, ProviderError


def now():
    return datetime.now(timezone.utc).isoformat()


def percentile(values, p):
    """Linear interpolation at rank (n-1)*p, including all attempts."""
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered)-1) * p
    lo, hi = math.floor(rank), math.ceil(rank)
    return round(ordered[lo] + (ordered[hi]-ordered[lo])*(rank-lo), 2)


def summarize(rows):
    latency = [r['latencyMs'] for r in rows]
    question_count = sum(len(r['questionChecks']) for r in rows)
    correct_questions = sum(sum(r['questionChecks'].values()) for r in rows)
    completed = sum(r['completed'] for r in rows)
    correct = sum(r['correct'] for r in rows)
    return {
        'n':len(rows), 'completed':completed, 'failed':len(rows)-completed,
        'correctObservations':correct, 'accuracy':round(correct/len(rows), 6) if rows else None,
        'questionCount':question_count, 'correctQuestions':correct_questions,
        'questionAccuracy':round(correct_questions/question_count, 6) if question_count else None,
        'p50Ms':percentile(latency,.5), 'p95Ms':percentile(latency,.95),
        'totalMs':round(sum(latency),2), 'meanMs':round(statistics.mean(latency),2) if latency else None,
        'reportedCostUsd':sum(r.get('result',{}).get('usage',{}).get('cost',0) or 0 for r in rows),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures',type=Path,default=ROOT/'evidence'/'frozen-observations.json')
    parser.add_argument('--output',type=Path,default=ROOT/'evidence'/'benchmark.json')
    parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--providers',nargs='+',default=['clef','jev','luna'])
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error('--repeats must be 1–10')
    fixture_bytes=args.fixtures.read_bytes()
    source=json.loads(fixture_bytes)
    fixtures=source['fixtures']
    if not fixtures or any(not isinstance(f['state'],str) for f in fixtures):
        parser.error('Expected nonempty frozen text fixtures')
    report={
        'startedAt':now(), 'completedAt':None, 'complete':False,
        'fixtureSha256':hashlib.sha256(fixture_bytes).hexdigest(),
        'sourceSha256':source['sourceSha256'], 'seed':source['seed'],
        'methodology':{
            'task':'Frozen text-observation decision accuracy, not live task completion or screenshot performance.',
            'observations':len(fixtures), 'repeats':args.repeats, 'providers':args.providers,
            'plannedRequests':len(fixtures)*len(args.providers)*args.repeats,
            'ordering':'Sequential requests; each observation is sent to every provider. Provider order rotates left one position each repetition.',
            'latency':'Provider adapter wall time includes network, OpenRouter routing, inference, response transfer and validation. All attempts included; no discarded warmup or local cache.',
            'percentiles':'Linear interpolation at sorted rank (n-1)*p; small N, descriptive only.',
            'accuracy':'All named choices must match ground truth; array ground truth accepts any listed choice. Request failures count as incorrect.',
            'groundTruth':'Only state and questions are passed to execute_decision. Expected answers are used after inference for scoring.',
            'confidence':'Native confidence and probabilities are preserved without calibration, thresholds, or transformations. Chat returns null confidence/probabilities.',
            'clefRouting':'cloudflare/clef-flash pinned to Cloudflare with provider.only and allow_fallbacks=false; no substituted models.',
            'jevRouting':'typesafe/jev-1.13 through OpenRouter; text only.',
            'lunaRouting':'openai/gpt-6-luna through OpenRouter Chat Completions, strict JSON schema, reasoning effort none.',
            'limitations':['Two observations per demo and three repetitions are not representative production coverage.','Repeated inputs may benefit from upstream prompt caches; no local result cache is used.','Frozen observations do not test model recovery from earlier mistakes or complete workflow success.'],
        },
        'fixtures':[{'id':f['id'],'kind':f['kind'],'meta':f['meta'],'expected':f['expected']} for f in fixtures],
        'results':[], 'summary':{}
    }
    def save():
        report['summary']={
            'byProvider':{p:summarize([r for r in report['results'] if r['provider']==p]) for p in args.providers},
            'byScenario':{kind:{p:summarize([r for r in report['results'] if r['provider']==p and r['kind']==kind]) for p in args.providers} for kind in dict.fromkeys(f['kind'] for f in fixtures)},
        }
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
    for repeat in range(args.repeats):
        rotation=repeat%len(args.providers)
        order=args.providers[rotation:]+args.providers[:rotation]
        for fixture in fixtures:
            for provider in order:
                row={'sequence':len(report['results'])+1,'repeat':repeat+1,'fixtureId':fixture['id'],'kind':fixture['kind'],'provider':provider,'startedAt':now()}
                started=time.perf_counter()
                try:
                    result=execute_decision(provider,fixture['state'],fixture['questions'],timeout=40)
                    checks={key:(result['answers'].get(key,{}).get('choice') in expected if isinstance(expected,list) else result['answers'].get(key,{}).get('choice')==expected) for key,expected in fixture['expected'].items()}
                    row.update(completed=True,result=result,latencyMs=result['latencyMs'],questionChecks=checks,correct=all(checks.values()))
                except ProviderError as exc:
                    row.update(completed=False,error=exc.as_dict(),latencyMs=round((time.perf_counter()-started)*1000,2),questionChecks={key:False for key in fixture['expected']},correct=False)
                report['results'].append(row)
                save()
                print(json.dumps({key:row[key] for key in ['sequence','repeat','fixtureId','provider','completed','correct','latencyMs']}),flush=True)
    report.update(completedAt=now(),complete=True)
    save()
    print(json.dumps(report['summary']['byProvider'],indent=2))
    return 0 if all(r['completed'] for r in report['results']) else 1


if __name__=='__main__':
    raise SystemExit(main())
