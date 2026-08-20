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

  // ---- config-persistence audit logging (Task 9; observation-only) ----------
  // The backend already persists + restores the agent config; these surface the
  // load/apply/activate transitions in Manage>Debug so "did my saved workspace
  // come back without pressing Set?" is answerable without guessing.
  const _dbg = (cat, ev, data) => { try { if (window.DEBUG) DEBUG.log(cat, ev, data); } catch { /* noop */ } };
  const _cfgSnap = () => ({ enabled: !!cfg.enabled, permission: cfg.mode, approval: cfg.approval,
    dry_run: !!cfg.dry_run, force_agent: !!cfg.force_agent, root: cfg.root,
    root_valid: !!cfg.root_valid, root_active: !!cfg.root_active });
  let _loadLogged = false;        // [AGENT CONFIG LOAD] once, at first sync (boot)
  let _wasActive = null;          // track root_active transitions -> [WORKSPACE ACTIVATE]

  function _auditAfterSync() {
    if (!_loadLogged) {           // first authoritative read from the backend = the restored state
      _loadLogged = true;
      _dbg('agent', '[AGENT CONFIG LOAD]', _cfgSnap());
    }
    const active = !!cfg.root_active;
    if (active !== _wasActive) {  // false->true (or true->false) is worth recording
      _dbg('workspace', '[WORKSPACE ACTIVATE]', {
        root: cfg.root, active, root_valid: !!cfg.root_valid, enabled: !!cfg.enabled });
      _wasActive = active;
    }
  }

  async function refresh() {
    try {
      // no-store: WebView2 caches GETs aggressively -- a stale cached registry
      // was hiding newly-added tools (e.g. weather) from the model + the UI.
      const d = await (await fetch('/api/plugins/tools', { cache: 'no-store' })).json();
      if (d && d.config) cfg = Object.assign(cfg, d.config, {
        root: d.root_resolved || d.config.root,
        root_valid: !!d.root_valid,
        // workspace is ACTIVE when tools are enabled AND the root is a real dir
        root_active: !!(d.config.enabled && d.root_valid),
      });
      if (d && Array.isArray(d.tools)) tools = d.tools;
      _auditAfterSync();
    } catch { /* keep last known */ }
    return { cfg, tools };
  }

  async function setConfig(patch) {
    const before = _cfgSnap();
    const d = await (await fetch('/api/plugins/tool/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    })).json();
    if (d && d.config) cfg = Object.assign(cfg, d.config, { root: d.root_resolved || d.config.root });
    await refresh();
    _dbg('agent', '[AGENT CONFIG APPLY]', { patch: patch || {}, before, after: _cfgSnap() });
    return cfg;
  }

  const allowed = () => tools.filter((t) => t.allowed);
  const byName = (n) => tools.find((t) => t.name === n) || null;

  // ---- system prompt (tools the model may call, given the current mode) -----
  // The registry is the SINGLE SOURCE OF TRUTH: the plugins UI, the tool schema,
  // the model prompt, the generated JSON example and the backend validation all
  // derive from the same per-tool `args` list -- no hand-duplicated definitions.

  // Exact nested-JSON call shape for a tool, generated from its schema. This is
  // the format the model must emit, e.g. {"tool":"read_file","args":{"path":"<path>"}}
  function exampleCall(t) {
    const a = {};
    for (const arg of (t.args || [])) a[arg.name] = '<' + arg.name + '>';
    return JSON.stringify({ tool: t.name, args: a });
  }

  // A per-tool advertisement block. Every tool shows its EXACT CALL shape (the
  // decisive fix: the model obeys the nested schema when shown it literally).
  // compact=true (STANDARD) drops the prose/per-arg lines but KEEPS the CALL line.
  function toolBlock(t, compact) {
    const req = (t.args || []).filter((a) => a.required !== false).map((a) => a.name);
    const opt = (t.args || []).filter((a) => a.required === false).map((a) => a.name);
    const lines = ['TOOL: ' + t.name];
    if (!compact && t.description) lines.push('  ' + t.description);
    lines.push('  Required args: ' + (req.length ? req.join(', ') : '(none)')
      + (opt.length ? '   Optional args: ' + opt.join(', ') : ''));
    if (!compact)
      for (const a of (t.args || []))
        lines.push('    - ' + a.name + ' (' + a.type
          + (a.required === false ? ', optional' : '') + '): ' + (a.description || ''));
    lines.push('  CALL: ' + exampleCall(t));
    return lines.join('\n');
  }
  const toolBlocks = (av, compact) => av.map((t) => toolBlock(t, compact)).join('\n\n');

  const forceAgent = () => !!cfg.force_agent;

  // STANDARD-mode tool subset (bounded single-file work). preview_diff is
  // CONTROLLER-owned in STANDARD so it is intentionally not advertised here.
  const STANDARD_TOOLS = new Set(['read_file', 'list_files', 'write_file', 'check_code']);

  // tools advertised to the model for a given execution mode (Phase 7 filtering)
  function toolsForMode(mode) {
    const av = allowed();
    if (mode === 'simple') return [];
    if (mode === 'standard') return av.filter((t) => STANDARD_TOOLS.has(t.name));
    return av;                              // agent -> full permitted set
  }

  // conservative router (Phase 3/4): picks which PROMPT + tools to send. Safety
  // is NOT decided here -- the loop enforces plans/limits regardless. SIMPLE only
  // when clearly no tools; AGENT on any danger/multi signal; else STANDARD.
  const TOOLY = /\b(file|files|read|open|show|display|view|cat|contents?|write|create|make|edit|modify|change|update|append|save|list|ls|folder|directory|dir|check|validate|syntax|preview|diff|workspace|script|code|\.(py|js|ts|jsx|json|md|txt|csv|html|css|ya?ml|sh|bat|ini|cfg|log))\b/i;
  const DANGER = /\b(delete|remove|rm\b|move|rename|run|execute|install|pip|package|dependency|npm|terminal|command|venv|environment|virtualenv)\b/i;
  const MULTI = /\b(files|multiple|several|each|every|all\s+the|both|project|across|three|two\s+files|then|after that|and then|refactor)\b/i;

  // explicit file paths named in the request -- quoted tokens or bare filenames
  // with a known extension. Used ONLY for router DEBUG context (Task 8), never to
  // decide routing (that stays keyword-based + loop-enforced).
  const _EXT = 'py|js|ts|jsx|json|md|txt|csv|html?|css|ya?ml|sh|bat|ini|cfg|log|xml|toml';
  function explicitPaths(text) {
    const t = String(text || '');
    const out = new Set();
    let m;
    const q = /["'`]([^"'`\n]{1,120})["'`]/g;               // quoted path/filename
    while ((m = q.exec(t))) {
      const s = m[1].trim();
      if (new RegExp('\\.(?:' + _EXT + ')$', 'i').test(s) || /[\\/]/.test(s)) out.add(s);
    }
    const f = new RegExp('(?:^|[\\s(])([\\w.-]+\\.(?:' + _EXT + '))\\b', 'gi');  // bare file.ext
    while ((m = f.exec(t))) out.add(m[1]);
    return [...out].slice(0, 8);
  }

  // Full routing decision WITH a human-readable reason + request_class + the
  // explicit paths (Task 8 router context). classifyMode() is just its .mode.
  function classifyInfo(text) {
    const explicit_paths = explicitPaths(text);
    if (!enabled())
      return { mode: 'simple', reason: 'tool access disabled', request_class: 'interactive', explicit_paths };
    if (forceAgent())
      return { mode: 'agent', reason: 'force_agent A/B override', request_class: 'forced-agent', explicit_paths };
    const t = String(text || '');
    // A request that NAMES a registered non-file tool (e.g. "weather"), or clearly
    // wants a specialized tool, must ENGAGE the tool loop -- otherwise it has no
    // file keyword, routes SIMPLE, and the model's tool call is shown as text and
    // never executed. Route to AGENT so the full tool set (incl. plugin tools) is
    // advertised; read tools still run without a plan.
    const namesTool = tools.some((x) => x.source !== 'builtin'
      && new RegExp('\\b' + x.name.replace(/[_-]+/g, '[ _-]?') + '\\b', 'i').test(t));
    if (namesTool || /\b(weather|forecast|temperature)\b/i.test(t))
      return { mode: 'agent', reason: 'names a specialized/plugin tool', request_class: 'tool-intent', explicit_paths };
    if (!TOOLY.test(t) && !DANGER.test(t))
      return { mode: 'simple', reason: 'no file/tool keywords', request_class: 'interactive', explicit_paths };
    if (DANGER.test(t))
      return { mode: 'agent', reason: 'dangerous verb (delete/move/run/install)', request_class: 'dangerous-op', explicit_paths };
    if (MULTI.test(t))
      return { mode: 'agent', reason: 'multi-file / sequential signal', request_class: 'multi-file', explicit_paths };
    return { mode: 'standard', reason: 'bounded single-file operation', request_class: 'file-op', explicit_paths };
  }
  function classifyMode(text) { return classifyInfo(text).mode; }

  // CORE rules -- always sent when tools are enabled (kept compact)
  const CORE = [
    'You can use TOOLS on files in the user’s workspace. Call ONE tool per reply as a single raw JSON',
    'object and nothing else: {"tool":"name","args":{...}} (a ```json fenced block is also accepted; no',
    'XML, no other shape — malformed JSON is rejected).',
    '',
    'ALL tool arguments MUST be nested under "args" — NEVER beside "tool".',
    '  CORRECT: {"tool":"read_file","args":{"path":"test.txt"}}',
    '  WRONG:   {"tool":"read_file","path":"test.txt"}',
    'Copy the exact CALL shape shown for each tool below and fill in the values.',
    '',
    'You then get a JSON [TOOL RESULT] {"success":..,"output":..,"error":..} which is AUTHORITATIVE —',
    'never restate, reformat or invent a result. Paths are relative to the workspace; anything outside it',
    'is rejected. When finished, reply in plain prose with NO JSON.',
  ];

  // modular system prompt by execution mode (Phase 6)
  function systemPrompt(mode) {
    if (!enabled() || mode === 'simple') return '';
    const av = toolsForMode(mode);
    if (!av.length) return '';
    if (mode === 'standard') {
      return CORE.concat([
        '',
        'This is a simple, bounded single-file task — no [PLAN] needed. To create OR edit a file, call',
        'write_file with the FULL new content; the system automatically previews the diff, verifies file',
        'integrity, writes, and syntax-checks for you in one step. If you need the current contents before',
        'deciding the change, call read_file first. Do not call preview_diff yourself.',
        '',
        'Available tools (copy the CALL shape exactly; all args go inside "args"):',
        toolBlocks(av, true),
      ]).join('\n');
    }
    // AGENT mode
    return CORE.concat([
      '',
      'PLAN FIRST (required before any write/move/delete/create/run/install): reply with a plain-text plan',
      'and NO tool call — numbered 1..N, at most 5 steps, no duplicates, one short sentence per step, and',
      'every file step names its path:',
      '[PLAN]',
      '1. Preview changes to app.py.',
      '2. Write app.py.',
      'ONE step = ONE tool call. Never combine [PLAN] text and a tool JSON in one reply. Execute one step',
      'per reply. To edit an existing file: preview_diff(path,new_content) as its own step, then write_file',
      'with the same path (unchanged since the preview).',
      '',
      'DELETING a file is NOT an edit: do NOT call preview_diff and do NOT write empty content first —',
      'preview_diff/write_file are ONLY for changing a file. To delete, plan a verify-then-delete and call',
      'delete_file directly (it needs no diff and no hash):',
      '[PLAN]',
      '1. Verify test2.txt exists.',
      '2. Delete test2.txt.',
      'then {"tool":"read_file","args":{"path":"test2.txt"}} then {"tool":"delete_file","args":{"path":"test2.txt"}}.',
      'MOVING/renaming and CREATING a directory also need NO preview_diff — just plan the step and call',
      'move_file / create_directory. delete_file must be its own single-purpose step.',
      'Stop as soon as the goal is achieved and any required validation passed.',
      '',
      'Available tools (copy the CALL shape exactly; all args go inside "args"):',
      toolBlocks(av, false),
    ]).join('\n');
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
      // FLAT-ARGS GUARD (feedback only -- NO auto-repair, NO moving args): reject a
      // call that placed arguments BESIDE "tool" instead of inside "args". Signal:
      // "args" carries nothing, yet a top-level key matches a declared arg name.
      if (!Object.keys(args).length) {
        const declared = new Set((t.args || []).map((a) => a.name));
        const misplaced = Object.keys(obj).filter((k) => k !== 'tool' && k !== 'args' && declared.has(k));
        if (misplaced.length)
          return { malformed: true, error: 'Malformed tool call: all arguments must be inside "args". Expected: ' + exampleCall(t) };
      }
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

  // ---- Task 7 diagnostics: expose exactly what detect() saw + the schema ------
  // The ISOLATED candidate JSON string detect() would parse (or null) -- the same
  // fence/brace extraction, so [TOOL CANDIDATE RAW] shows the precise text the
  // parser received. Diagnostic only; never used for execution.
  function rawCandidate(text) {
    if (!text) return null;
    const s = String(text).trim();
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fm;
    while ((fm = fenceRe.exec(s))) {
      const c = fm[1].trim();
      if (c[0] === '{') return c;
    }
    if (s[0] === '{') return s;
    return null;
  }

  // Compact schema for one tool (or the whole advertised set for a mode): the
  // arg contract the model was given, so a missing path can be traced to whether
  // the model was even told the arg was required.
  function schemaFor(name) {
    const t = byName(name);
    if (!t) return null;
    return { tool: t.name, access: t.access, source: t.source,
      args: (t.args || []).map((a) => ({ name: a.name, type: a.type, required: a.required !== false })) };
  }

  // a write/exec call needs confirmation when approval == "confirm"
  function needsConfirm(call) {
    return approval() === 'confirm' && call && call.access !== 'read';
  }

  // tools that MUTATE state -> require a plan + are step-matched (Phase 1/3)
  const MUTATORS = new Set(['write_file', 'move_file', 'delete_file',
    'create_directory', 'run_command', 'pip_install']);
  const isMutator = (name) => MUTATORS.has(name);

  // Parse + VALIDATE a [PLAN] block (Phase 2). Returns:
  //   null            -> no plan present
  //   {error}         -> a plan was written but is invalid
  //   {steps}         -> a valid plan
  function parsePlan(text) {
    if (!enabled() || !text) return null;
    const m = text.match(/\[\s*plan\s*\]([\s\S]*)/i);
    if (!m) return null;
    const nums = [], steps = [];
    const re = /^\s*(\d+)[.)]\s+(.+?)\s*$/gm;
    let s;
    while ((s = re.exec(m[1]))) { nums.push(parseInt(s[1], 10)); steps.push(s[2].trim()); }
    if (!steps.length) return { error: 'Plan is empty. Use [PLAN] then numbered steps.' };
    if (steps.length > 5) return { error: 'Plan has too many steps (max 5).' };
    for (let i = 0; i < nums.length; i++)
      if (nums[i] !== i + 1) return { error: 'Plan steps must be sequentially numbered 1..N.' };
    const seen = new Set();
    for (const st of steps) {
      const k = st.toLowerCase();
      if (seen.has(k)) return { error: 'Plan contains duplicate identical steps.' };
      seen.add(k);
    }
    // a step describing a file mutation must reference a path (has an extension or a slash)
    const fileVerb = /\b(write|create|edit|update|save|move|rename|delete|remove|append)\b/i;
    for (const st of steps)
      if (fileVerb.test(st) && !/[./\\]/.test(st))
        return { error: 'Each file operation step must reference an explicit file path.' };
    return { steps };
  }

  // Does a tool call plausibly match a plan step's intent? (Phase 3, path-first)
  function stepMatches(stepText, call) {
    const s = (stepText || '').toLowerCase();
    const paths = [call.args && call.args.path, call.args && call.args.path_from,
      call.args && call.args.path_to].filter(Boolean).map((p) => String(p).toLowerCase());
    for (const p of paths) {
      const base = p.split(/[\\/]/).pop();
      if (base && (s.includes(base) || s.includes(p))) return true;
    }
    if (s.includes(call.name)) return true;
    const verbs = {
      write_file: ['write', 'create', 'save', 'add', 'update', 'edit', 'append'],
      move_file: ['move', 'rename'], delete_file: ['delete', 'remove'],
      create_directory: ['create', 'directory', 'folder', 'mkdir'],
      run_command: ['run', 'execute'], pip_install: ['install', 'pip', 'package', 'dependency'],
    };
    for (const v of (verbs[call.name] || [])) if (s.includes(v)) return true;
    return false;
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

  window.TOOLS = { enabled, mode, approval, forceAgent, refresh, setConfig,
    systemPrompt, classifyMode, classifyInfo, toolsForMode, detect, parsePlan,
    stepMatches, isMutator, run, needsConfirm, looksFaked, isEnvError, errKey,
    forbidden, rawCandidate, schemaFor, list: () => tools, config: () => cfg };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => { refresh(); });
  else refresh();
})();
