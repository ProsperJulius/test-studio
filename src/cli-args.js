// Parses command-line arguments for the headless runner.

const USAGE = `Test Studio command line

Usage:
  test-studio run [options]        Run tests and write reports
  test-studio validate [options]   Check tests for problems without running them
  test-studio list [options]       List the tests that would run

Where tests come from:
  --suite <folder>        Suite folder exported from Test Studio (recommended for CI).
                          Without it, the tests saved in the Test Studio app on this computer are used.

Choosing tests:
  --tag <tags>            Only tests with any of these tags (comma separated, repeatable)
  --exclude-tag <tags>    Leave out tests with these tags
  --test <ids>            Only these test IDs (comma separated, repeatable)
  --approved-only         Only tests approved in QA review

Environment:
  --env <name>            Environment profile to use (default: the suite's active environment)
  --base-url <url>        Override the environment's base address
  --build <version>       Build version printed on reports
  Secret test data:       set TS_VAR_<name>, for example TS_VAR_password=...

Running:
  --retries <n>           Re-run a failed test up to n times; passes on retry are marked flaky
  --timeout <seconds>     Step timeout
  --headed                Show the browser windows

Reports:
  --out <folder>          Where to write results (default: ./test-results)
  --docx                  Also write the Word evidence document
  --warnings-as-errors    Fail validation on warnings too

Exit codes: 0 all tests passed, 1 tests failed, 2 could not run.`;

const FLAGS = new Set(['approved-only', 'headed', 'docx', 'warnings-as-errors', 'help']);
const REPEATABLE = new Set(['tag', 'exclude-tag', 'test']);
const VALUES = new Set(['suite', 'tag', 'exclude-tag', 'test', 'env', 'base-url', 'build', 'retries', 'timeout', 'out']);

function parseArgs(argv) {
  const args = { command: null, tag: [], 'exclude-tag': [], test: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { args.help = true; continue; }
    if (!a.startsWith('--')) {
      if (args.command) throw new Error('Unexpected argument “' + a + '”.');
      args.command = a;
      continue;
    }
    let [name, inline] = a.slice(2).split(/=(.*)/s);
    if (FLAGS.has(name)) { args[name] = true; continue; }
    if (!VALUES.has(name)) throw new Error('Unknown option --' + name + '.');
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new Error('--' + name + ' needs a value.');
    if (REPEATABLE.has(name)) args[name].push(value);
    else args[name] = value;
  }
  if (args.help || !args.command) args.command = args.command || 'help';
  if (!['run', 'validate', 'list', 'help'].includes(args.command)) throw new Error('Unknown command “' + args.command + '”.');
  for (const k of ['retries', 'timeout']) {
    if (args[k] != null && !/^\d+$/.test(args[k])) throw new Error('--' + k + ' must be a whole number.');
  }
  return args;
}

module.exports = { parseArgs, USAGE };
