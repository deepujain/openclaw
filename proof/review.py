"""Offline input checks; candidate operations are only valid in the disposable CI checkout."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

PROOF = Path(__file__).resolve().parent
BASE = 'b0f0d4a3f9c1426a1501e97dee51546b7d4ddcec'
PRE = '0ea8cb4d0192111ffa234d77fe63a01bbe0c20af'
T1 = '580bc22825a5937f3de7199c64e48b5c4ac67837'
VALIDATOR = 'packages/gateway-protocol/src/compiled/protocol.generated/predicates.js'
REQUIRED = ('src/gateway/server-methods/update-status-schedule.test.ts',
            'ui/src/pages/config/updates-actions.test.tsx', 'ui/src/pages/config/updates.test.ts',
            'ui/src/app/update-confirmation.runtime.test.ts')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def unique_object(pairs):
    obj = dict(pairs)
    need(len(obj) == len(pairs), 'duplicate JSON key')
    return obj


def load(path):
    return json.loads(path.read_bytes().decode('utf-8'), object_pairs_hook=unique_object)


def fields(obj, names):
    need(type(obj) is dict and obj.keys() == set(names.split()), f'expected fields: {names}')


def suite(path):
    return re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?\Z', path) is not None


def safe_path(path):
    need(isinstance(path, str) and '/' in path and all(
        re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', part) for part in path.split('/')
    ) and not path.startswith('proof/'), f'not a literal repository path: {path!r}')
    return path


def paths(value, tests_only=False):
    need(type(value) is list, 'expected an array of paths')
    for path in value:
        safe_path(path)
        need(not tests_only or suite(path), f'not a test file: {path}')
    need(len(set(value)) == len(value), 'duplicate path')
    return set(value)


def inputs(root=PROOF):
    patch = root / 'review-fixes.patch'
    manifest = root / 'review-manifest.json'
    provenance = root / 'review-provenance.json'
    for path in (patch, manifest, provenance):
        need(path.is_file() and not path.is_symlink(), f'missing or nonregular input: {path}')
    prov = load(provenance)
    fields(prov, 'version preReviewTree expectedTree validatorBlob patchSha256 manifestSha256 changedPaths')
    need(type(prov['version']) is int and prov['version'] == 1 and prov['preReviewTree'] == PRE, 'wrong provenance version or pre-review tree')
    for key in ('expectedTree', 'validatorBlob'):
        need(re.fullmatch('[0-9a-f]{40}', prov[key]) and int(prov[key], 16), f'invalid {key}')
    need(prov['expectedTree'] == T1, 'expectedTree differs from the authorized T1')
    for file, key in ((patch, 'patchSha256'), (manifest, 'manifestSha256')):
        need(prov[key] == hashlib.sha256(file.read_bytes()).hexdigest(), f'{file.name}: SHA-256 mismatch')
    changed = paths(prov['changedPaths'])
    need(any(not suite(path) for path in changed), 'no non-test review changes')
    spec = load(manifest)
    fields(spec, 'version red focused')
    need(type(spec['version']) is int and spec['version'] == 1, 'wrong manifest version')
    focused = paths(spec['focused'], tests_only=True)
    need(type(spec['red']) is list and spec['red'], 'red cases required')
    cases = {}
    for case in spec['red']:
        fields(case, 'file title assertionContains' if 'assertionContains' in case else 'file title')
        path = safe_path(case['file'])
        need(suite(path) and path in changed, f'red file not changed: {path}')
        for key in case.keys() - {'file'}:
            text = case[key]
            need(isinstance(text, str) and text.strip() and text.isprintable(), f'invalid {key}')
        titles = cases.setdefault(path, {})
        need(case['title'] not in titles, f'duplicate red case: {case}')
        titles[case['title']] = case.get('assertionContains', '')
    return prov, changed, cases, focused


def git(*args, env=None):
    return subprocess.check_output(['git', *args], env=env)


def oid(*args, env=None):
    return git(*args, env=env).decode('ascii').strip()


def delta(before, after):
    return set(git('diff', '--no-renames', '--name-only', '-z', before, after, '--').decode().split('\0')[:-1])


def clean_index(tree):
    need(oid('write-tree') == tree, 'unexpected index tree')
    git('diff', '--exit-code', '--')


def check_file(result, file, expected, red):
    failures = expected if red else {}
    need(result['name'] == str(Path.cwd() / file) and result['message'] == '' and
         result['status'] == ('failed' if failures else 'passed'), f'{file}: incorrect suite or suite error')
    rows = result['assertionResults']
    need(any(row['status'] in ('passed', 'failed') for row in rows), f'{file}: no executed tests')
    actual = [row for row in rows if row['status'] == 'failed']
    need(len(actual) == len(failures) and {row['title'] for row in actual} == set(failures),
         f"{file}: unexpected failed cases: {[row['title'] for row in actual]}")
    for title, needle in expected.items():
        row, = [row for row in rows if row['title'] == title]
        if red:
            messages = row['failureMessages']
            need(messages and all(msg.startswith('AssertionError:') and needle in re.split(r'\n\s+at ', msg, 1)[0]
                                  for msg in messages), f'{file}: wrong assertion for {title}: {messages}')
            print(f'RED {file} :: {title} :: {messages[0].splitlines()[0]}', flush=True)
        else:
            need(row['status'] == 'passed' and row['failureMessages'] == [], f'{file}: did not pass: {title}')
            print(f'GREEN {file} :: {title}', flush=True)


def run_suite(file, expected, red):
    with tempfile.TemporaryDirectory(dir='/work', prefix='vitest-proof-') as temp:
        report = Path(temp) / 'vitest.json'
        guard = Path(temp) / 'run-health.json'
        args = ['pnpm', 'test', file, '--maxWorkers=1', '--reporter=json',
                f'--reporter={PROOF}/review-reporter.mjs', f'--outputFile={report}']
        code = subprocess.run(args, env=dict(os.environ, REVIEW_HEALTH=str(guard))).returncode
        need(code == int(red and bool(expected)), f'{file}: unexpected exit code {code}')
        health = load(guard)
        failures = expected if red else {}
        need(health == {'reason': 'failed' if failures else 'passed', 'problems': []},
             f'{file}: incomplete run, hook, runner, or non-assertion error: {health}')
        native = load(report)
        result, = native['testResults']
        need(native['success'] is (not failures) and native['numFailedTests'] == len(failures) and
             native['numTotalTests'] == len(result['assertionResults']), f'{file}: unexpected overall result')
        check_file(result, file, expected, red)


def final_checks(final, all_tests, cases):
    clean_index(final)
    changed = sorted(delta(BASE, final))
    formatted = [safe_path(path) for path in changed if Path(path).is_file()]
    need(formatted, 'empty format selection')
    subprocess.run(['pnpm', 'format:check', *formatted], check=True)
    clean_index(final)
    for file in sorted(all_tests):
        run_suite(file, cases.get(file, {}), False)
    clean_index(final)


def candidate(mode, prov, changed, cases, focused):
    need(PROOF == Path('/proof') and Path.cwd() == Path('/work/source'), 'CI checkout only')
    final = prov['expectedTree']
    tests = {path for path in changed if suite(path)}
    all_tests = tests | set(REQUIRED) | focused
    if mode == 'green':
        all_tests.update(safe_path(path) for path in delta(BASE, final) if suite(path) and Path(path).is_file())
        final_checks(final, all_tests, cases)
        return
    clean_index(PRE)
    with tempfile.TemporaryDirectory(dir='/work', prefix='review-index-') as temp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temp) / 'index'))
        git('read-tree', PRE, env=env)
        git('apply', '--cached', '--whitespace=error-all', str(PROOF / 'review-fixes.patch'), env=env)
        need(oid('write-tree', env=env) == final, 'review patch does not produce expectedTree')
    need(delta(PRE, final) == changed and changed <= delta(BASE, final), 'review patch outside final changed paths or allowlist mismatch')
    need(oid('rev-parse', f'{final}:{VALIDATOR}') == prov['validatorBlob'], 'wrong validator blob')
    for path in all_tests:
        need(git('ls-tree', final, '--', path).startswith(b'100644 blob '), f'not a regular final test: {path}')
    git('restore', f'--source={final}', '--staged', '--worktree', '--', *sorted(tests))
    red_tree = oid('write-tree')
    need(delta(PRE, red_tree) == tests and delta(red_tree, final) == changed - tests, 'incorrect test-only tree')
    clean_index(red_tree)
    print(f'PRE {PRE}  RED {red_tree}  EXPECTED GREEN {final}', flush=True)
    for path in sorted(tests):
        run_suite(path, cases.get(path, {}), True)
    clean_index(red_tree)
    git('restore', f'--source={final}', '--staged', '--worktree', '--', *sorted(changed - tests))
    clean_index(final)


if __name__ == '__main__':
    mode, = sys.argv[1:]
    prov, changed, cases, focused = inputs()
    if mode == 'pins':
        print(prov['expectedTree'], prov['validatorBlob'])
    elif mode != 'inputs':
        need(mode in ('red-then-apply', 'green'), 'unknown command')
        candidate(mode, prov, changed, cases, focused)
