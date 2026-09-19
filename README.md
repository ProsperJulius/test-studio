# Test Studio (desktop)

A desktop app for business users to record, review, run and evidence regression tests on a web application, with no coding. It matches the Test Studio prototype screens.

## Run it

Requires Node.js 20 or later.

```bash
npm install
npm start
```

Build an installer:

```bash
npm run dist:win     # Windows .exe installer
npm run dist:mac     # macOS .dmg (build on a Mac)
npm run dist:linux   # Linux AppImage
```

## First use

1. Open **Environments** and set the base address for each environment (QA, UAT, Staging). Open **Settings** and enter the application name and build version.
2. On **Tests**, click **Record new test**, give it a name and a start page, then click **Start recording**.
3. A browser window opens. Use the application as normal. Steps appear in Test Studio as you go.
4. To add a pass/fail check, click **Add check for this page**, then click the text in the browser that proves the step worked.
5. Click **Stop and review steps**. Edit, reorder or delete steps, then **Run test**.
6. When the run finishes, click **Download evidence (.docx)**.

## What each screen does

| Screen | Purpose |
|---|---|
| Tests | List, search, filter by tag, record, edit, run and delete tests. Run all approved tests or the filtered set. **Check suite** lists problems such as tests without checks, missing blocks and unknown test data. |
| Step editor | Change actions, targets and values with dropdowns and text fields. Set tags, priority and the requirement or story. Hide secret values, toggle screenshots, save steps as a reusable block, submit for QA review and approve. |
| Run | Live step-by-step progress with screenshots; click a thumbnail to enlarge. Shows retries, flaky tests, changes since the last run, and steps whose element was found only by position or text. |
| Evidence preview | On-screen version of the Word document. |
| Runs | History of every run: view, re-download the Word document, open the HTML report or the screenshot folder. |
| Reusable blocks | Shared step sequences inserted into tests with the **Use block** action. |
| Test data | Default values used in steps as `{name}`, for example `{username}`. Mark passwords as **Secret**. |
| Environments | Base address and test data overrides per environment. Switch the active environment at the top of the window. |
| Schedules | Run approved, all, or tagged tests against a chosen environment on set days while the app is open. |
| Settings | Details printed on the evidence cover, step timeout, retries, whether the browser is visible during runs, and suite export/import. |

## Step actions

**Actions:** Open page, Click, Double-click, Right-click, Type, Select, Press Enter, Wait, Take screenshot, Use block, Save value from text.

**Checks:** Verify text appears, Verify text is not shown, Verify element is visible / hidden / enabled / disabled, Verify field value (use `checked` or `unchecked` for checkboxes), Verify element text, Verify page address contains, Verify page title, Verify no console errors.

Each check waits up to the step timeout for the condition to become true.

## Locators (Playwright style)

Each step finds its element with a **Playwright-style locator**, the same syntax developers use in Playwright tests:

```js
getByRole('button', { name: 'Save order' })
getByLabel('Email')
getByTestId('sign-in')
getByRole('dialog', { name: 'Edit order' }).getByRole('button', { name: 'Cancel' })
getByRole('listitem').filter({ hasText: 'Pears' }).getByRole('button')
```

**Recording** picks a locator the way Playwright codegen does and checks it matches exactly one element: test ID, then role and accessible name, placeholder, label, alt text, text, title, then an element ID. If none is unique, it scopes to a container that is (a dialog, a table row, a list item with some text); as a last resort it adds `.nth()`.

**Business users** can ignore the locator: the step keeps a plain name such as *Save order* for descriptions and reports. **QA engineers** see the locator under the name in the step editor and can edit it. It is checked as you type, with a plain-English reading such as *Finds the “Cancel” button in the “Edit order” dialog*. While recording, **Try a locator** outlines the matching elements in the browser and says how many there are.

**Running** follows Playwright's rules: text and names match case-insensitively as a substring unless `exact: true`; `getByRole` ignores elements hidden from assistive technology unless `includeHidden: true`; and locators are **strict**. A step fails straight away if its locator matches more than one element, telling you to add `.first()`, `.nth()` or be more specific. Test data works inside locators: `getByRole('row', { name: 'Order {orderId}' })`.

Supported: `getByRole` (options `name`, `exact`, `checked`, `disabled`, `expanded`, `includeHidden`, `level`, `pressed`, `selected`), `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`, `locator(css)` and `locator('xpath=…')`, chained calls, `.first()`, `.last()`, `.nth()`, and `.filter({ hasText, hasNotText, visible })`. The test ID attribute (default `data-testid`) is set in **Settings**, like Playwright's `testIdAttribute`.

Tests recorded before locators were added keep working as before. Open a step and click **Convert to locator** to switch it; **Check suite** lists steps that still use older targets.

`npm run test:parity` checks that Test Studio matches exactly the same elements as real Playwright for 125 locators on `test/fixture/site/locators.html`.

## AG Grid

Clicks, double-clicks and right-clicks on [AG Grid](https://www.ag-grid.com/) cells and headers are recorded by **column and row**, not by position on the page:

- **Cells** are found by a key value, for example *Double-click “Notes” in the Orders grid, row where Order ID is “1250”*. The recorder picks an ID-like column (Order ID, Number, Reference, Code) whose value is unique; otherwise it uses the row position. The value can be test data or a saved value: `{orderId}`. In the step editor you can choose **Contains** instead of **Is exactly**, so `jane` finds *Jane Smith (Manager)*.
- **Tree data** (for example a file explorer) is recorded by **path**: *Click “Created” in the grid, row “Documents › Work › ProjectAlpha › Proposal.docx”*. The same name in different folders is told apart, and collapsed folders on the path are opened while the test runs. Clicking a row's arrow is recorded as **Expand the row** or **Collapse the row**; these do nothing if the row is already that way, so they are safe to repeat.
- **Headers:** clicking the header text (sorts), the column menu button, the filter button, or the filter box under the header.
- **Buttons and links inside cells** (for example an *Edit* button that opens a form) are recorded as such.
- **Editing:** double-click the cell, type, and press Enter. The Type and Press Enter steps are tied to the same cell. A Type step on a cell that is not being edited opens it with a double-click by itself.
- **Checking a row is not there:** *Verify element is hidden* on a grid row passes only after the whole grid has been searched. It does not open collapsed tree folders, so a row inside a collapsed folder counts as not shown.

When running, the grid is scrolled to find rows and columns that are not on screen, so tests keep working after sorting, filtering or new data. Grid and popup interactions use real mouse input. AG Grid's popups (column menus, filters, context menus, dropdown editors) and your own dialogs are recorded like any other page element.

In the step editor, **Edit grid target** changes the grid (by its heading), the part, the column, and how the row is found. **Use a grid cell or header** turns an ordinary step into a grid step. Tested with AG Grid Community 32 and 36, and with AG Grid 36 tree data (Enterprise).

## Saving values for later steps

A **Save value from text** step saves part of a message so later steps can use it. Its value is the message with the part to save in curly brackets:

| Message on the page | Value | Saves |
|---|---|---|
| Order 5001 created successfully | `Order {orderId} created` | `orderId` = 5001 |
| Your booking reference is BK-99812. | `booking reference is {bookingId}` | `bookingId` = BK-99812 |
| Customer Jane Doe placed order #77 | `Customer {name} placed order #{id}` | `name` = Jane Doe, `id` = 77 |

Use the saved value like any test data, for example `Open page /orders/{orderId}`, or to find a grid row. The step waits up to the step timeout for a matching message anywhere on the page, including toast notifications; set **On** to limit it to one element. Advanced users can give a regular expression with named groups instead: `/Order (?<orderId>\d+)/`.

**While recording**, pop-up messages appear under **Messages seen** even if they disappear quickly. Click **Save a value from this** to add the step at the point the message appeared, with a suggested name such as `{orderId}`. **Save value from page** does the same for text you click in the browser.

Saved values belong to the test that saves them and are saved again on each retry. Tick **Share with later tests** to let later tests in the same run use a value; those tests then fail if run on their own, and **Check suite** reports that. Saved values are listed in the run results and evidence document.

## Running regression tests from the command line and CI

The command-line runner uses the same step engine as the app, without the studio window. Use it in CI pipelines or with the operating system scheduler (cron, Task Scheduler) for unattended runs.

1. In **Settings**, click **Export suite to folder…** and choose an empty folder in your repository, for example `regression/`. Each test, block and environment becomes a JSON file, so changes can be reviewed in pull requests.
2. Commit the folder. Secret values are never exported: supply them as environment variables named `TS_VAR_<name>`, for example `TS_VAR_password`.
3. Run it:

```bash
npx test-studio validate --suite regression
npx test-studio run --suite regression --env UAT --tag smoke --approved-only --retries 1 --docx
```

Without `--suite`, the runner uses the tests saved in the app on this computer, and the run appears in the app's **Runs** page.

| Option | Meaning |
|---|---|
| `--tag`, `--exclude-tag`, `--test` | Choose tests (comma separated, repeatable) |
| `--approved-only` | Only tests approved in QA review |
| `--env`, `--base-url`, `--build` | Environment profile, address override, build version for reports |
| `--retries <n>` | Re-run failed tests; a test that passes on retry is reported as flaky |
| `--timeout <seconds>` | Step timeout |
| `--headed` | Show the browser windows |
| `--out <folder>` | Results folder (default `./test-results`) |
| `--docx` | Also write the Word evidence document |
| `--warnings-as-errors` | Make `validate` fail on warnings |

Exit codes: `0` all passed, `1` tests failed, `2` could not run (bad options, validation errors, no matching tests).

Each run writes `<out>/<run id>/` containing `junit.xml` (for CI test dashboards), `results.json`, `report.html`, `run.json`, screenshots and optionally `evidence.docx`. `<out>/latest.json` points at the newest run, and `<out>/history.json` stores each test's last result, so reports label **New failure**, **Still failing** and **Fixed**. Keep the `--out` folder between runs (for example as a CI cache) to keep that comparison.

**Linux CI** needs a virtual display: `xvfb-run --auto-servernum npx test-studio run ...`. See `.github/workflows/test-studio.yml` for a GitHub Actions example that also publishes the JUnit report and results.

To import changes others made to the suite, use **Import suite from folder…** in Settings. Tests with the same ID are replaced; secret values already on this computer are kept.

## Testing Test Studio itself

```bash
npm test            # unit tests (Node test runner)
npm run test:e2e    # runs test/e2e/suite against the fixture app in test/fixture
npm run test:parity # compares the locator engine with real Playwright (playwright-core, no browser download)
npm run test:recorder # records clicks and typing and checks the generated locators
npm run fixture     # starts the fixture app on http://127.0.0.1:4173 for manual recording
```

The end-to-end suite covers every check type, reusable blocks, secret test data, retries and flaky detection, expected failures, reports, run comparison, AG Grid sorting, scrolling, editing, header filters and cell buttons, and saving values from toasts, including sharing them between tests. The fixture's orders grid is at `/orders.html` (AG Grid 32) and `/orders-v36.html` (AG Grid 36, with pinned columns). Tree data needs AG Grid Enterprise, which this project does not include, so `npm run test:live-aggrid` checks it against AG Grid's public File Explorer example instead; it needs internet access and is not part of `test:e2e`.

## How it works

```
main.js                 Electron main process: windows, IPC, runs, scheduler
preload.js              Safe bridge between the studio UI and main process
renderer/               Studio UI (plain HTML, CSS, JavaScript)
src/recorder.js         Opens the recording window and collects steps
src/recorder-preload.js Injected into the app under test; captures clicks, typing, selections, Enter, checks
src/runner.js           Replays steps in a fresh browser window, retries failed tests, captures screenshots
src/report.js           Builds the Word evidence document with the docx library
src/reporters.js        JUnit XML, JSON and HTML reports; comparison with the previous run
src/store.js            Saves tests, blocks, test data, environments, settings and run history as JSON
src/secrets.js          Encrypts secret values with the operating system keychain
src/suite.js            Exports, loads and imports suite folders
src/cli.js              Command-line runner (bin/test-studio.js starts it)
src/environments.js     Resolves the environment, test data and TS_VAR_ overrides for a run
src/select.js           Chooses tests by ID, tag and approval
src/validate.js         Finds problems in tests before they run
src/steps.js            Expands blocks, substitutes test data, chooses locators
src/capture.js          Save value from text: templates, extraction and suggestions
src/locator-parse.js    Parses, formats and describes Playwright-style locators
src/locator-engine.js   Finds elements for locators in the page and generates locators when recording
src/describe.js         Step types and their plain-English sentences
```

**Recording.** For every element the recorder stores several ways to find it again: test ID attributes (`data-testid`, `data-test`, `data-qa`, `data-cy`), element ID, label, placeholder, name, visible text and a CSS path.

**Running.** Each test runs in its own clean browser session. For each step the runner tries those locators in order and waits up to the step timeout. If a user renames a step's target in the editor, the runner looks for an element with that label or text instead. The runner records which locator found each element and flags steps found only by visible text or CSS position, which are the most likely to break. After each step it takes a screenshot if enabled. When a step fails, it records the error, takes a screenshot, collects browser console errors and skips the remaining steps. With retries set, the whole test runs again in a new session; earlier attempts are kept in the results.

**Evidence document.** Cover details, summary, per-step results with screenshots, a defect appendix for failures, and sign-off fields. Every run keeps its screenshots, so the document can be downloaded again later.

## Where data is stored

In the app's user data folder, under `data/`:

- Windows: `%APPDATA%\Test Studio\data`
- macOS: `~/Library/Application Support/Test Studio/data`
- Linux: `~/.config/Test Studio/data`

`studio.json` holds tests, blocks, test data, environments, settings and run history. Secret values in it are encrypted with the operating system keychain where one is available. When an older `studio.json` is upgraded, the original is kept as `studio.backup-schema1.json`. `runs/<run id>/` holds `run.json`, the JUnit/JSON/HTML reports and the screenshots.

## Known limitations

- **Sharing tests.** The app edits tests on one computer. Share them by exporting a suite folder into version control and importing it on other computers. There is no live multi-user editing.
- **Iframes and shadow DOM** are not recorded or replayed.
- **Custom controls** (canvas-based grids, some date pickers, drag and drop) may need extra step types.
- **Clicks are simulated with JavaScript.** A few apps ignore these; switching Click to trusted input events via `webContents.sendInputEvent` in `runner.js` fixes that.
- **MFA and SSO** on the application under test need a dedicated test account without MFA, or a pre-authenticated session.
- **Secrets** are encrypted at rest only where the operating system keychain is available (on Linux this needs a keyring service); otherwise they are stored in plain text. Hidden step values typed directly into a step are not exported; use a secret `{variable}` instead.
- **Schedules** in the app only run while Test Studio is open. For unattended runs, use the command-line runner from CI or the operating system scheduler.
- **Approval** has no user roles in this version; anyone using the app can approve. Using pull request reviews on the exported suite folder gives an auditable approval trail.
- **AG Grid:** rows are found by scrolling through the grid, so very large grids (thousands of rows) take longer, and server-side row models only work if rows load within about a minute. Tree data rows are found by path, but grouped rows (row grouping) and master/detail rows are matched by their cell values only. The column menu button is supported but only header text, filter button and cell interactions are covered by automated tests. Canvas-based grids are not supported.
- **Saved values:** a message shown for less than about half a second can be missed while running.
- **Locators:** accessible names follow Playwright for common HTML and ARIA but not every edge case of the accname specification; shadow DOM and iframes are not searched. Not supported: `has`/`hasNot` filters, `and`/`or`, `frameLocator`. Actions wait for the element to be visible, not for Playwright's full actionability checks (stable, enabled, receiving events).
- **Not yet included:** data-driven tests (CSV rows), setup/teardown and API steps, parallel runs, screenshot comparison against a baseline, and trend charts across many runs.

## Security notes

- The studio window uses context isolation with no Node.js access in the UI.
- Only listed IPC channels are exposed through the preload bridge.
- Recording and run windows use isolated, temporary browser sessions.
