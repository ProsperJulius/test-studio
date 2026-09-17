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

1. Open **Settings** and enter the application name, environment, build version and base address.
2. On **Tests**, click **Record new test**, give it a name and a start page, then click **Start recording**.
3. A browser window opens. Use the application as normal. Steps appear in Test Studio as you go.
4. To add a pass/fail check, click **Add check for this page**, then click the text in the browser that proves the step worked.
5. Click **Stop and review steps**. Edit, reorder or delete steps, then **Run test**.
6. When the run finishes, click **Download evidence (.docx)**.

## What each screen does

| Screen | Purpose |
|---|---|
| Tests | List, record, edit, run and delete tests. Run all approved tests. |
| Step editor | Change actions, targets and values with dropdowns and text fields. Hide secret values, toggle screenshots, save steps as a reusable block, submit for QA review and approve. |
| Run | Live step-by-step progress with screenshots; click a thumbnail to enlarge. |
| Evidence preview | On-screen version of the Word document. |
| Runs | History of every run: view, re-download the Word document, open the screenshot folder. |
| Reusable blocks | Shared step sequences inserted into tests with the **Use block** action. |
| Test data | Named values used in steps as `{name}`, for example `{username}`. |
| Schedules | Run approved (or all) tests at a set time on chosen days while the app is open. |
| Settings | Details printed on the evidence cover, base address, step timeout, and whether the browser is visible during runs. |

## Step actions

Open page, Click, Type, Select, Press Enter, Verify text appears, Wait, Take screenshot, Use block.

## How it works

```
main.js                 Electron main process: windows, IPC, runs, scheduler
preload.js              Safe bridge between the studio UI and main process
renderer/               Studio UI (plain HTML, CSS, JavaScript)
src/recorder.js         Opens the recording window and collects steps
src/recorder-preload.js Injected into the app under test; captures clicks, typing, selections, Enter, checks
src/runner.js           Replays steps in a fresh browser window and captures screenshots
src/report.js           Builds the Word evidence document with the docx library
src/store.js            Saves tests, blocks, test data, settings and run history as JSON
src/describe.js         Turns a step into a plain-English sentence
```

**Recording.** For every element the recorder stores several ways to find it again: test ID attributes (`data-testid`, `data-test`, `data-qa`, `data-cy`), element ID, label, placeholder, name, visible text and a CSS path.

**Running.** Each test runs in its own clean browser session. For each step the runner tries those locators in order and waits up to the step timeout. If a user renames a step's target in the editor, the runner looks for an element with that label or text instead. After each step it takes a screenshot. When a step fails, it records the error, takes a screenshot, collects browser console errors and skips the remaining steps.

**Evidence document.** Cover details, summary, per-step results with screenshots, a defect appendix for failures, and sign-off fields. Every run keeps its screenshots, so the document can be downloaded again later.

## Where data is stored

In the app's user data folder, under `data/`:

- Windows: `%APPDATA%\Test Studio\data`
- macOS: `~/Library/Application Support/Test Studio/data`
- Linux: `~/.config/Test Studio/data`

`studio.json` holds tests, blocks, test data, settings and run history. `runs/<run id>/` holds `run.json` and the screenshots.

## Known limitations

- **Single user, local storage.** Tests live on one computer. To share tests across a team, point the store at a shared database or add a small API (see the delivery plan).
- **Iframes and shadow DOM** are not recorded or replayed.
- **Custom controls** (canvas-based grids, some date pickers, drag and drop) may need extra step types.
- **Clicks are simulated with JavaScript.** A few apps ignore these; switching Click to trusted input events via `webContents.sendInputEvent` in `runner.js` fixes that.
- **MFA and SSO** on the application under test need a dedicated test account without MFA, or a pre-authenticated session.
- **Secrets** in Test data and hidden step values are stored in plain text. Use test-only accounts, or replace with the operating system keychain (for example `keytar` or Electron `safeStorage`).
- **Schedules** only run while Test Studio is open. For unattended overnight runs, run the same step engine in CI.
- **Approval** has no user roles in this version; anyone using the app can approve.

## Security notes

- The studio window uses context isolation with no Node.js access in the UI.
- Only listed IPC channels are exposed through the preload bridge.
- Recording and run windows use isolated, temporary browser sessions.
