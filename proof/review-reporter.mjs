import { writeFileSync } from 'node:fs';

export default class ReviewReporter {
  onTestRunEnd(modules, unhandled, reason) {
    const problems = unhandled.map(error => `unhandled: ${error.name}: ${error.message}`);
    for (const file of modules) {
      for (const suite of [file, ...file.children.allSuites()]) {
        for (const error of suite.errors()) problems.push(`suite: ${error.message}`);
        if (!suite.ok() && ![...suite.children.allTests('failed')].length) {
          problems.push(`failed suite without a failed assertion: ${suite.name}`);
        }
      }
      for (const test of file.children.allTests()) {
        const result = test.result();
        if (result.state === 'pending') problems.push(`unfinished: ${test.name}`);
        if (Object.values(test.task.result?.hooks ?? {}).some(state => state !== 'pass')) {
          problems.push(`unfinished or failed hook: ${test.name}`);
        }
        if (result.state === 'failed' && (!result.errors?.length ||
            result.errors.some(error => error.name !== 'AssertionError'))) {
          problems.push(`not an assertion failure: ${test.name}`);
        }
      }
    }
    writeFileSync(process.env.REVIEW_HEALTH, JSON.stringify({ reason, problems }), { flag: 'wx' });
  }
}
