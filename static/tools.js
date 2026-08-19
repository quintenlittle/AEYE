/* ================================================================
   AEYE -- agentic tools (LLM-callable plugins + built-in file tools).

   Mirrors the WEB tool module: it injects a system prompt describing the
   available tools, detects a tool call in the model's reply, runs it against
   the backend (which enforces mode + path confinement), and hands the result
   back to chat.js to feed into the next round.

   Disabled by default -> systemPrompt() is empty and detect() returns null, so
   AEYE stays purely interactive until you turn tool access on in Manage>Plugins.
   ================================================================ */
(() => {
  'use strict';

  let cfg = { enabled: false, mode: 'read', approval: 'auto', root: '' };
  let tools = [];                 // [{name, access, source, description, args, allowed}]

  const enabled = () => !!cfg.enabled;
  const mode = () => cfg.mode || 'read';
  const approval = () => cfg.approval || 'auto';

  async function refresh() {
    try {
      const d = await (await fetch('/api/plugins/tools')).json();
      if (d && d.config) cfg = Object.assign(cfg, d.config, { root: d.root_resolved || d.config.root });
      if (d && Array.isArray(d.tools)) tools = d.tools;
    } catch { /* keep last known */ }
    return { cfg, tools };
  }

  async function setConfig(patch) {
    const d = await (await fetch('/api/plugins/tool/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    })).json();
    if (d && d.config) cfg = Object.assign(cfg, d.config, { root: d.root_resolved || d.config.root });
    await refresh();
    return cfg;
  }

  const allowed = () => tools.filter((t) => t.allowed);
  const byName = (n) => tools.find((t) => t.name === n) || null;

  // ---- system prompt (tools the model may call, given the current mode) -----
  function argSig(t) {
    return (t.args || []).map((a) =>
      a.name + (a.required === false ? '?' : '')).join(', ');
  }
  function systemPrompt() {
    if (!enabled()) return '';
    const av = allowed();
    if (!av.length) return '';
    const lines = av.map((t) => {
      const args = (t.args || []).map((a) =>
        '    - ' + a.name + ' (' + a.type + (a.required === false ? ', optional' : '') + '): '
        + (a.description || '')).join('\n');
      return '- ' + t.name + '(' + argSig(t) + '): ' + (t.description || '')
        + (args ? '\n' + args : '');
    }).join('\n');
    return [
      'You can use TOOLS to read and write files inside the user’s workspace.',
      'To call a tool, reply with ONLY a single raw JSON object in EXACTLY this format and nothing else:',
      '{"tool": "tool_name", "args": {"key": "value"}}',
      '(A ```json fenced block is also accepted.) Do NOT use XML, <tool_call> tags, function-call syntax,',
      'or any other shape — only that exact JSON object. Malformed JSON will be rejected.',
      'You will then receive a JSON [TOOL RESULT] of the form {"success":true,"output":"…","error":null}',
      '(or {"success":false,"output":null,"error":"…"}). Read it, then continue or give your final answer.',
      'Rules: at most ONE tool call per reply; only call a tool when it genuinely helps; when you already',
      'have the answer, reply in plain prose with NO JSON. File paths are relative to the workspace.',
      'NEVER write "[TOOL RESULT]" or a result yourself — that comes only from the system after a real call.',
      'SCOPE: you may ONLY use the tools listed below. You cannot install packages, change the environment,',
      'run shell commands, or fix dependencies — no such tools exist. If a task needs an uninstalled',
      'dependency, say so plainly and STOP; do not retry.',
      '',
      'Available tools:',
      lines,
    ].join('\n');
  }

  // ---- STRICT tool-call detection (JSON ONLY) -------------------------------
  // Accept ONLY a raw JSON object, or a ```json``` fenced JSON object, of exactly
  // {"tool":"name","args":{...}}. No XML/alternative formats, no substring
  // extraction, NO repair of malformed JSON. Anything that looks like an attempt
  // but isn't valid is REJECTED as malformed.
  // Returns: a valid call, {malformed:true,error}, or null (prose final answer).
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  function detect(text) {
    if (!enabled() || !text) return null;
    const s = text.trim();
    // ACCEPTED: a ```json``` fenced block whose content is a JSON object (even
    // with surrounding prose), OR a reply that is itself a raw JSON object.
    // NOT accepted: bare {...} pulled out of prose (no extraction), XML, etc.
    let jsonStr = null;
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fm;
    while ((fm = fenceRe.exec(s))) {
      const c = fm[1].trim();
      if (c[0] === '{') { jsonStr = c; break; }   // first fenced JSON object wins
    }
    if (jsonStr === null && s[0] === '{') jsonStr = s;

    if (jsonStr !== null) {
      const obj = tryParse(jsonStr);               // strict parse -- NO repair
      if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return { malformed: true, error: 'Malformed JSON tool call. Reply with ONLY {"tool":"name","args":{...}}.' };
      const name = obj.tool;
      if (typeof name !== 'string' || !name.trim())
        return { malformed: true, error: 'Invalid tool call: "tool" must be a string. Use {"tool":"name","args":{...}}.' };
      let args = (obj.args === undefined) ? {} : obj.args;
      if (typeof args !== 'object' || Array.isArray(args) || args === null)
        return { malformed: true, error: 'Invalid tool call: "args" must be an object.' };
      const t = byName(name.trim());
      if (!t)
        return { malformed: true, error: 'Unknown tool "' + name.trim() + '". Available tools: ' + tools.map((x) => x.name).join(', ') + '.' };
      const preview = (t.args || []).map((a) => {
        const v = args[a.name];
        return v == null ? null : a.name + '=' + String(v).slice(0, 40);
      }).filter(Boolean).join(', ');
      return { name: name.trim(), args, access: t.access, label: '⚙ ' + name.trim() + '(' + preview + ')' };
    }

    // an XML / <tool_call> style attempt: do NOT parse it -- nudge back to JSON
    if (/^<\s*(?:tool_call|tool|function)\b/i.test(s))
      return { malformed: true, error: 'Tool calls must be raw JSON, not XML. Reply with ONLY {"tool":"name","args":{...}}.' };

    return null;                                   // plain prose -> final answer
  }

  // a write/exec call needs confirmation when approval == "confirm"
  function needsConfirm(call) {
    return approval() === 'confirm' && call && call.access !== 'read';
  }

  // run a tool and return the {success, output, error} CONTRACT, fed back to the
  // model verbatim as JSON so it consumes results in one consistent shape
  async function run(call) {
    let d;
    try {
      d = await (await fetch('/api/plugins/tool/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: call.name, args: call.args }),
      })).json();
    } catch (e) {
      d = { success: false, output: null, error: 'transport error: ' + e.message };
    }
    const contract = {
      success: !!d.success,
      output: d.success ? (d.output == null ? '' : d.output) : null,
      error: d.success ? null : (d.error || 'tool failed'),
    };
    const disp = contract.success ? String(contract.output) : ('ERROR: ' + contract.error);
    return {
      message: '[TOOL RESULT]\n' + JSON.stringify(contract),
      display: disp.length > 600 ? disp.slice(0, 600) + '\n…' : disp,
      ok: contract.success,
      error: contract.error || '',
    };
  }

  // the model sometimes fabricates our result wrapper instead of calling a tool
  function looksFaked(text) {
    if (!enabled() || !text) return false;
    return /\[\s*tool\s+result\s*\]/i.test(text.trim());
  }

  // ---- loop-stability helpers ----------------------------------------------
  // an environment/dependency failure can't be fixed with file tools -> stop
  function isEnvError(text) {
    return /\b(ModuleNotFoundError|ImportError|No module named|cannot import name|AttributeError|DLL load failed)\b/i
      .test(String(text || ''));
  }
  // normalise an error so "the same error twice" compares reliably: strip memory
  // addresses, timestamps, file paths, line numbers and other numeric noise
  function errKey(text) {
    return String(text || '').toLowerCase()
      .replace(/0x[0-9a-f]+/g, '<addr>')                              // memory addresses
      .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.,]+z?/g, '<ts>')            // ISO timestamps
      .replace(/\d{1,2}:\d{2}:\d{2}/g, '<ts>')                        // clock times
      .replace(/[a-z]:\\[^\s"']+/g, '<path>').replace(/\/[^\s"']+/g, '<path>')  // paths
      .replace(/line \d+/g, 'line <n>').replace(/:\d+/g, ':<n>')      // line numbers
      .replace(/\d+/g, '#')                                           // any remaining numbers
      .replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  // an out-of-scope attempt: a tool-call-shaped emission whose action name is a
  // package/env/shell verb (and is NOT one of our real tools). Only inspects the
  // CALL name, so ordinary file content mentioning "pip" is never flagged.
  function forbidden(text) {
    if (!enabled() || !text) return null;
    let s = String(text).trim();
    const wrap = s.match(/<(?:tool_call|tool|function)[^>]*>([\s\S]*?)<\/(?:tool_call|tool|function)>/i);
    if (wrap) s = wrap[1].trim();
    let name = '';
    let m = s.match(/"(?:name|tool|function|action)"\s*:\s*"([^"]+)"/i);
    if (m) name = m[1];
    if (!name && (m = s.match(/^\s*<\s*([A-Za-z_]\w*)/))) name = m[1];
    if (!name && (m = s.match(/\b([A-Za-z_]\w*)\s*\(/))) name = m[1];
    name = (name || '').toLowerCase();
    if (!name || byName(name)) return null;   // unknown-but-harmless / real tool
    if (/install|pip|npm|yarn|apt|conda|dependenc|package|shell|bash|\bexec\b|system|subprocess|run_?command|setenv|environment|chmod|sudo|winget|choco/i
      .test(name))
      return { name, label: '⛔ ' + name + ' (out of scope)' };
    return null;
  }

  window.TOOLS = { enabled, mode, approval, refresh, setConfig, systemPrompt,
    detect, run, needsConfirm, looksFaked, isEnvError, errKey, forbidden,
    list: () => tools, config: () => cfg };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => { refresh(); });
  else refresh();
})();
