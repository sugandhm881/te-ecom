// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CODE (CLI) — the ANALYSIS brain, run on the Max subscription instead of the paid API.
//
// Why (user, 2026-09-04: "for call kind of anyalsis use calude code max plan and only for brain use
// clause api"): the audit ships up to 60 full transcripts per run, which is by far the largest
// prompt this system sends, and it is billed per token. The live call brain must STAY on the API —
// it needs a first sentence inside a second and cannot depend on a CLI starting up — but nothing
// about an on-demand audit is latency-critical. So analysis moves here and the phone call does not.
//
// NO SILENT FALLBACK TO THE PAID API. That is deliberate and it is the lesson from the same day: a
// "free" path that quietly heals itself by calling the billed one is indistinguishable from never
// having moved at all, and you only find out on the invoice. If the CLI is missing or not logged
// in, this throws with a message saying exactly that. Set CALL_INSIGHTS_ALLOW_API=true if you ever
// want the old behaviour back, and then it is a choice rather than a surprise.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { spawn } = require('child_process');
const os = require('os');

// Windows resolves `claude` to claude.cmd, which spawn() will not run without a shell — hence
// shell:true below. CLAUDE_CLI overrides with an absolute path when the CLI is not on the server
// process's PATH (a very common case: the PATH a service inherits is not a login shell's PATH).
const CLI = () => process.env.CLAUDE_CLI || 'claude';
const TIMEOUT_MS = () => Number(process.env.CLAUDE_CLI_TIMEOUT_MS || 300000);   // an audit is minutes, not seconds

// THE WHOLE POINT IS TO SPEND THE SUBSCRIPTION, NOT THE API BUDGET — and Claude Code's credential
// order puts ANTHROPIC_API_KEY ABOVE the subscription token, with the docs noting that in
// non-interactive mode (-p) "the key is always used when present". So if either of these ever
// appears in the server's environment, every audit would quietly go back to being billed and the
// logs would look identical. This project uses CLAUDE_API_KEY for the call brain, which the CLI
// ignores, but a stray ANTHROPIC_API_KEY on a host would be invisible — so strip both here.
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is what a headless VPS authenticates with.
function childEnv() {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
}

function cliAvailable() {
    return new Promise((resolve) => {
        const p = spawn(CLI(), ['--version'], { shell: true, windowsHide: true, env: childEnv() });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', () => resolve(null));
        p.on('close', (code) => resolve(code === 0 ? out.trim().slice(0, 60) : null));
        setTimeout(() => { try { p.kill(); } catch (_) {} resolve(null); }, 15000);
    });
}

// Ask Claude Code one question and get the text back. No tools, one turn: this is a thinking task
// over text we already hold, not an agent that should be reading the repo. It runs in the temp
// directory on purpose so it never picks up this project's CLAUDE.md and never sees a git tree.
function askClaudeCode(prompt, { system = '', model = '' } = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-p', '--output-format', 'json'];
        if (model) args.push('--model', model);
        if (system) args.push('--append-system-prompt', system);
        const p = spawn(CLI(), args, { shell: true, windowsHide: true, cwd: os.tmpdir(), env: childEnv() });
        let out = '', err = '';
        const timer = setTimeout(() => {
            try { p.kill(); } catch (_) {}
            reject(new Error('Claude Code timed out after ' + Math.round(TIMEOUT_MS() / 1000) + 's'));
        }, TIMEOUT_MS());
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(new Error('Claude Code could not start: ' + e.message)); });
        p.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                return reject(new Error('Claude Code exited ' + code + ': ' + (err || out).slice(0, 300)));
            }
            // --output-format json wraps the answer; older/newer shapes have differed, so accept the
            // wrapper OR a bare string rather than trusting one field name.
            let text = '';
            try {
                const d = JSON.parse(out);
                text = typeof d === 'string' ? d : (d.result || d.text || d.content || '');
                if (typeof text !== 'string') text = JSON.stringify(text);
            } catch (_) { text = out; }
            text = String(text || '').trim();
            if (!text) return reject(new Error('Claude Code returned nothing (stderr: ' + err.slice(0, 200) + ')'));
            resolve(text);
        });
        // The prompt goes on stdin, not argv: an audit prompt is tens of kilobytes and every OS has a
        // command-line length limit well below that (Windows is ~32k).
        p.stdin.on('error', () => {});
        p.stdin.write(prompt);
        p.stdin.end();
    });
}

module.exports = { askClaudeCode, cliAvailable, CLI };
