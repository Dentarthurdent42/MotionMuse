import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { generateReport } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, 'test-results');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

// ── Local HTTP server ─────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const filePath = join(ROOT, req.url === '/' ? 'index.html' : req.url);
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Viewports ─────────────────────────────────────────────────────────────────
const VIEWPORTS = [
  { name: 'iPhone-SE',  width: 375,  height: 667,  mobile: true  },
  { name: 'iPhone-14',  width: 390,  height: 844,  mobile: true  },
  { name: 'iPad',       width: 768,  height: 1024, mobile: true  },
  { name: 'Desktop',    width: 1280, height: 800,  mobile: false },
];

// ── Test states ────────────────────────────────────────────────────────────────
// Each state describes what to do after the page loads before taking a screenshot.
const STATES = [
  {
    id: 'initial',
    label: 'Initial load',
    setup: async () => {},
  },
  {
    id: 'scrolled-bottom',
    label: 'Scrolled to bottom',
    setup: async (page) => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    },
  },
];

// ── Screenshot capture ─────────────────────────────────────────────────────────
async function captureAll(port) {
  const launchOptions = {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  };
  if (CHROME) launchOptions.executablePath = CHROME;
  const browser = await chromium.launch(launchOptions);

  const captures = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
      permissions: ['camera'],
    });
    const page = await ctx.newPage();

    for (const state of STATES) {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForLoadState('domcontentloaded');
      // Allow layout/fonts to settle
      await page.waitForTimeout(400);

      await state.setup(page);
      await page.waitForTimeout(200);

      const image = (await page.screenshot()).toString('base64');
      captures.push({
        id: `${vp.name}--${state.id}`,
        label: `${vp.name} (${vp.width}×${vp.height}) — ${state.label}`,
        viewport: vp,
        state: state.id,
        image,
      });
      console.log(`  captured: ${vp.name} / ${state.label}`);
    }

    await ctx.close();
  }

  await browser.close();
  return captures;
}

// ── Claude evaluation ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a mobile UX auditor specialising in creative tool interfaces. \
You are evaluating a motion-to-audio web app (MotionMuse) that musicians use live: \
it reads hand tracking and body pose via webcam and maps them to audio synthesis parameters. \
The audience is technically literate musicians who use it hands-free during performance.

Return ONLY valid JSON matching this exact schema — no markdown, no prose outside it:
{
  "score": <integer 0–10>,
  "summary": "<one sentence>",
  "issues": [
    {
      "severity": "error" | "warning" | "info",
      "area": "<short label, e.g. Touch Targets / Typography / Layout / Overflow / Navigation>",
      "description": "<what is wrong and where>",
      "suggestion": "<concrete fix>"
    }
  ]
}

Evaluate these criteria on mobile viewports; be lenient on desktop (1280+):
• Touch targets — interactive elements must be ≥44 px tall/wide; flag anything smaller
• Text legibility — body text <11 px is an error; low contrast text (contrast ratio <4.5:1 for normal text, <3:1 for large text) is an error
• Horizontal overflow — flag any content clipped or requiring horizontal scroll
• Information density — flag if content is too cramped for fingers to use accurately
• Layout integrity — does the grid/flex layout break at this viewport?
• Navigation clarity — are primary actions discoverable and reachable one-handed?`;

async function evaluate(client, captures) {
  const results = [];

  for (const cap of captures) {
    process.stdout.write(`  evaluating: ${cap.label} … `);
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }, // reuse cached system prompt across all calls
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: cap.image },
            },
            {
              type: 'text',
              text: `Viewport: ${cap.viewport.width}×${cap.viewport.height}, mobile: ${cap.viewport.mobile}, state: "${cap.state}". Evaluate mobile UX.`,
            },
          ],
        },
      ],
    });

    let evaluation;
    try {
      evaluation = JSON.parse(msg.content[0].text);
    } catch {
      // Attempt to extract JSON from mixed response
      const match = msg.content[0].text.match(/\{[\s\S]*\}/);
      try {
        evaluation = match ? JSON.parse(match[0]) : null;
      } catch {
        evaluation = null;
      }
      if (!evaluation) {
        evaluation = { score: 5, summary: 'Could not parse evaluation.', issues: [] };
      }
    }

    console.log(`score ${evaluation.score}/10, ${evaluation.issues.length} issue(s)`);
    results.push({ ...cap, evaluation });
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('Warning: ANTHROPIC_API_KEY not set — LLM evaluation skipped. Add it as a repo secret to enable.');
  }

  const server = await startServer();
  const { port } = server.address();
  console.log(`\nServing app on http://127.0.0.1:${port}`);

  try {
    console.log('\nCapturing screenshots…');
    const captures = await captureAll(port);

    let results;
    if (apiKey) {
      console.log(`\nEvaluating ${captures.length} screenshots with Claude…`);
      const client = new Anthropic({ apiKey });
      results = await evaluate(client, captures);
    } else {
      results = captures.map(cap => ({
        ...cap,
        evaluation: { score: null, summary: 'LLM evaluation skipped (ANTHROPIC_API_KEY not set).', issues: [] },
      }));
    }

    mkdirSync(OUT, { recursive: true });
    const reportPath = join(OUT, 'ui-ux-report.html');
    writeFileSync(reportPath, generateReport(results));
    console.log(`\nReport saved → ${reportPath}`);

    const errors = results.flatMap(r =>
      (r.evaluation.issues ?? []).filter(i => i.severity === 'error')
    );
    if (errors.length > 0) {
      console.error(`\n${errors.length} error(s) found — see report for details.`);
      process.exit(1);
    } else {
      console.log('\nNo errors found.');
    }
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
