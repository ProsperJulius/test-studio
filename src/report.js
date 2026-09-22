const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, Footer, PageNumber, BorderStyle
} = require('docx');
const { expectedResult } = require('./describe');

const INK = '1A1C20';
const MUTED = '585C64';
const PASS = '1D5E3B';
const FAIL = '9A2019';

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function colorFor(status) {
  if (status === 'Passed' || status === 'passed') return PASS;
  if (status === 'Failed' || status === 'failed') return FAIL;
  return MUTED;
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 50, type: WidthType.PERCENTAGE },
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [new TextRun({ text: String(text == null ? '' : text), bold: !!opts.bold, color: opts.color || INK, size: opts.size || 20 })]
      })
    ]
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after == null ? 80 : opts.after },
    children: [new TextRun({ text, color: opts.color || INK, bold: !!opts.bold, size: opts.size || 20, italics: !!opts.italics })]
  });
}

function labelled(label, value, color) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: label + ' ', color: MUTED, size: 20 }),
      new TextRun({ text: value, color: color || INK, bold: !!color, size: 20 })
    ]
  });
}

async function build(run, runDir, outFile) {
  const s = run.settings || {};
  const tests = run.tests || [];
  const allSteps = tests.flatMap((t) => t.steps);
  const count = (arr, st) => arr.filter((x) => x.status === st).length;

  const children = [];

  // ----- Cover -----
  children.push(para('Test execution evidence', { color: MUTED, size: 22, after: 60 }));
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: INK, space: 8 } },
      children: [
        new TextRun({
          text: tests.length === 1 ? tests[0].id + ' ' + tests[0].title : (s.appName || 'Application') + ' regression run',
          bold: true, size: 48, color: INK
        })
      ]
    })
  );

  const info = [
    ['Application', s.appName || '—'],
    ['Environment', s.environment || '—'],
    ['Build version', s.buildVersion || '—'],
    ['Started', fmt(run.startedAt)],
    ['Finished', fmt(run.finishedAt)],
    ['Executed by', (run.executedBy || '—') + ' using Test Studio'],
    ['Trigger', run.trigger || 'Manual']
  ];
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: info.map(([k, v]) => new TableRow({ children: [cell(k, { width: 30, color: MUTED, fill: 'F4F2EC' }), cell(v, { width: 70 })] }))
    })
  );

  // ----- Summary -----
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 }, children: [new TextRun({ text: 'Summary', bold: true, color: INK })] }));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: ['Overall result', 'Tests passed', 'Tests failed', 'Steps passed', 'Steps failed', 'Steps skipped'].map((h) => cell(h, { width: 16, bold: true, fill: 'F4F2EC', size: 18 }))
        }),
        new TableRow({
          children: [
            cell(run.status, { width: 16, bold: true, color: colorFor(run.status) }),
            cell(count(tests, 'Passed'), { width: 16 }),
            cell(count(tests, 'Failed'), { width: 16 }),
            cell(count(allSteps, 'passed'), { width: 16 }),
            cell(count(allSteps, 'failed'), { width: 16 }),
            cell(count(allSteps, 'skipped'), { width: 16 })
          ]
        })
      ]
    })
  );

  children.push(para('', { after: 120 }));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [cell('ID', { width: 15, bold: true, fill: 'F4F2EC' }), cell('Test', { width: 65, bold: true, fill: 'F4F2EC' }), cell('Result', { width: 20, bold: true, fill: 'F4F2EC' })] }),
        ...tests.map((t) => new TableRow({ children: [cell(t.id, { width: 15 }), cell(t.title, { width: 65 }), cell(t.status + (t.flaky ? ' (flaky)' : '') + (t.change === 'New failure' ? ' – new' : ''), { width: 20, bold: true, color: colorFor(t.status) })] }))
      ]
    })
  );

  // ----- Step evidence -----
  for (const t of tests) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { after: 80 },
        children: [new TextRun({ text: t.id + ' ' + t.title, bold: true, color: INK })]
      })
    );
    children.push(labelled('Result:', t.status + (t.flaky ? ' (flaky: passed on attempt ' + t.attempts + ')' : ''), colorFor(t.status)));
    if (t.change) children.push(labelled('Compared with last run:', t.change));
    if (t.requirement) children.push(labelled('Requirement:', t.requirement));
    if (Object.keys(t.captured || {}).length) children.push(labelled('Saved values:', Object.entries(t.captured).map(([k, v]) => k + ' = ' + v).join(', ')));
    if (t.tags && t.tags.length) children.push(labelled('Tags:', t.tags.join(', ')));
    for (const a of t.previousAttempts || []) {
      children.push(para('Attempt ' + a.attempt + ' failed at step ' + a.failedStep + ': ' + (a.error || ''), { color: MUTED }));
    }

    for (const st of t.steps) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 240, after: 60 },
          keepNext: true,
          children: [new TextRun({ text: 'Step ' + st.num + ': ' + st.text, bold: true, color: INK, size: 22 })]
        })
      );
      children.push(labelled('Result:', cap(st.status), colorFor(st.status)));
      children.push(para(expectedResult(st), { color: MUTED }));
      if (st.error) children.push(para('Actual: ' + st.error, { color: FAIL }));

      // The page as the step before left it. A step nearly always fails on what came before it, and
      // this is the picture that shows whether it did its job.
      if (st.beforeScreenshot) {
        const beforeFile = path.join(runDir, st.beforeScreenshot);
        if (fs.existsSync(beforeFile)) {
          children.push(para('The page before this step ran:', { color: MUTED }));
          const buf = fs.readFileSync(beforeFile);
          const { w, h } = pngSize(buf);
          const width = Math.min(600, w);
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new ImageRun({ type: 'png', data: buf, transformation: { width, height: Math.round((h / w) * width) } })]
            })
          );
        }
      }

      if (st.screenshot) {
        const file = path.join(runDir, st.screenshot);
        if (fs.existsSync(file)) {
          const buf = fs.readFileSync(file);
          const { w, h } = pngSize(buf);
          const width = Math.min(600, w);
          const height = Math.round((h / w) * width);
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new ImageRun({ type: 'png', data: buf, transformation: { width, height } })]
            })
          );
        }
      }
    }
  }

  // ----- Defect appendix -----
  const failures = tests.filter((t) => t.status === 'Failed');
  if (failures.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: 'Defect appendix', bold: true, color: INK })] }));
    for (const t of failures) {
      const f = t.steps.find((x) => x.status === 'failed');
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200 }, children: [new TextRun({ text: t.id + ' ' + t.title, bold: true, color: INK })] }));
      if (f) {
        children.push(labelled('Failed at:', 'Step ' + f.num + ': ' + f.text));
        children.push(labelled('Error:', f.error || '—', FAIL));
      }
      if (t.consoleErrors && t.consoleErrors.length) {
        children.push(para('Browser console errors:', { bold: true }));
        t.consoleErrors.slice(0, 20).forEach((m) => children.push(para('• ' + m, { color: MUTED, size: 18 })));
      }
    }
  }

  // ----- Sign-off -----
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 480, after: 160 }, children: [new TextRun({ text: 'Sign-off', bold: true, color: INK })] }));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: ['Tested by', 'Approved by', 'Date'].map((h) => cell(h, { width: 33, bold: true, fill: 'F4F2EC' })) }),
        new TableRow({
          height: { value: 900, rule: 'atLeast' },
          children: [cell('', { width: 33 }), cell('', { width: 33 }), cell('', { width: 33 })]
        })
      ]
    })
  );

  const doc = new Document({
    creator: 'Test Studio',
    title: 'Test execution evidence',
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], color: MUTED, size: 16 })]
              })
            ]
          })
        },
        children
      }
    ]
  });

  fs.writeFileSync(outFile, await Packer.toBuffer(doc));
  return outFile;
}

module.exports = { build };
