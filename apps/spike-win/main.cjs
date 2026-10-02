// Recast Windows spike. Measures four things and writes spike-results.json. It changes nothing on your system.
//  1. Key state: can we read ONE configured key (default Alt) by polling GetAsyncKeyState? At what rate? (No global keyboard hook, so no key logging.)
//  2. Overlay: does a transparent, click-through, always-on-top window appear without stealing focus, over normal and fullscreen apps, on your DPI and monitors?
//  3. Hit-testing: which window is under the cursor (WindowFromPoint) and what does UI Automation say about the element?
//  4. Elevated windows: what happens over an "Run as administrator" window (UIPI)?
const { app, BrowserWindow, screen } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)");
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *p)");
const WindowFromPoint = user32.func("void* __stdcall WindowFromPoint(POINT p)");
const GetAncestor = user32.func("void* __stdcall GetAncestor(void* hwnd, uint32 flags)");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void* hwnd, _Out_ RECT *r)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void* hwnd, _Out_ uint16 *buf, int max)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(void* hwnd, _Out_ uint16 *buf, int max)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32 *pid)");
const GetDpiForWindow = user32.func("uint32 __stdcall GetDpiForWindow(void* hwnd)");

const KEY = { Alt: 0x12, Shift: 0x10, Ctrl: 0x11, CapsLock: 0x14 }[process.env.RECAST_KEY || "Alt"];
const out = { spike: "recast-win-0.1", when: new Date().toISOString(), os: `${os.type()} ${os.release()} ${os.arch()}`, electron: process.versions.electron, node: process.versions.node, key: process.env.RECAST_KEY || "Alt", notes: [], results: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const w16 = (fn, hwnd) => { const b = Buffer.alloc(512); const n = fn(hwnd, b, 256); return b.toString("utf16le", 0, n * 2); };
const hwndKey = (h) => (h ? koffi.address(h).toString(16) : null);

function windowInfo(hwnd) {
  if (!hwnd) return null;
  const top = GetAncestor(hwnd, 2 /* GA_ROOT */) || hwnd;
  const r = {}; GetWindowRect(top, r); const pid = [0]; GetWindowThreadProcessId(top, pid);
  return { hwnd: hwndKey(top), title: w16(GetWindowTextW, top).slice(0, 80), class: w16(GetClassNameW, top), pid: pid[0], rect: [r.left, r.top, r.right - r.left, r.bottom - r.top], dpi: GetDpiForWindow(top) };
}
const uia = (x, y) => new Promise((resolve) => execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "uia-probe.ps1"), "-X", String(x), "-Y", String(y)], { timeout: 15000 }, (err, stdout) => { try { resolve(JSON.parse(stdout.trim().split("\n").pop())); } catch { resolve({ ok: false, error: String(err || stdout).slice(0, 200) }); } }));

async function pollKey(seconds) {
  // Poll the single key at ~1 kHz for a few seconds; report observed transitions and worst gap between polls.
  const t0 = now(); let last = false, downs = 0, ups = 0, polls = 0, worstGap = 0, prev = t0;
  while (now() - t0 < seconds * 1000) {
    const t = now(); worstGap = Math.max(worstGap, t - prev); prev = t; polls++;
    const down = (GetAsyncKeyState(KEY) & 0x8000) !== 0;
    if (down && !last) downs++; if (!down && last) ups++; last = down;
    await sleep(1);
  }
  return { seconds, polls, pollsPerSecond: Math.round(polls / seconds), worstGapMs: Number(worstGap.toFixed(2)), keyDowns: downs, keyUps: ups };
}

app.whenReady().then(async () => {
  try {
    const displays = screen.getAllDisplays();
    out.results.displays = displays.map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, internal: d.internal }));

    // 1. key polling
    console.log(`\n[1/4] Key state. For the next 6 seconds, press and release ${out.key} a few times (or not; both are useful).`);
    out.results.keyPoll = await pollKey(6);

    // 2. overlay
    console.log("\n[2/4] Overlay. A blue box will appear on top for 4 seconds. Keep working in whatever window you were using; DO NOT click it.");
    const before = windowInfo(GetForegroundWindow());
    const d = screen.getPrimaryDisplay();
    const win = new BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, show: false, webPreferences: { backgroundThrottling: false } });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, "screen-saver");
    await win.loadURL("data:text/html," + encodeURIComponent(`<body style="margin:0;background:transparent"><div id=b style="position:fixed;left:40px;top:40px;width:240px;height:60px;border:2px solid #2D50C8;background:rgba(45,80,200,.12);border-radius:8px;font:14px system-ui;color:#2D50C8;padding:8px">Recast overlay test</div><div id=c style="position:fixed;width:12px;height:12px;border-radius:6px;background:#B3261E;left:0;top:0"></div></body>`));
    const tShow = now(); win.showInactive();
    await sleep(400);
    const after = windowInfo(GetForegroundWindow());
    out.results.overlay = { foregroundBefore: before, foregroundAfter: after, focusStolen: !!before && !!after && before.hwnd !== after.hwnd, showMs: Number((now() - tShow).toFixed(1)), bounds: win.getBounds(), alwaysOnTop: win.isAlwaysOnTop() };
    // cursor agreement: Win32 physical cursor vs Electron's DIP cursor, to catch DPI / multi-monitor mapping errors
    const samples = [];
    for (let i = 0; i < 8; i++) { const p = {}; GetCursorPos(p); const e = screen.getCursorScreenPoint(); const disp = screen.getDisplayNearestPoint(e); samples.push({ win32: [p.x, p.y], electronDip: [e.x, e.y], scale: disp.scaleFactor, display: disp.id }); await sleep(450); }
    out.results.cursorMapping = samples;
    win.close();

    // 3. hit-testing + UIA under the cursor
    console.log("\n[3/4] Hit-testing. You have 25 seconds. Rest the mouse over things for ~3 seconds each: a browser page, Notepad, File Explorer, Excel/Word, VS Code, a game or full-screen video if you have one.");
    const seen = new Map(); const t0 = now(); const uiaRuns = [];
    while (now() - t0 < 25000) {
      const p = {}; GetCursorPos(p); const tHit = now(); const hw = WindowFromPoint({ x: p.x, y: p.y }); const info = windowInfo(hw); const hitMs = now() - tHit;
      const key = info ? `${info.class}|${info.pid}` : "none";
      if (info && !seen.has(key) && uiaRuns.length < 12) { seen.set(key, true); const r = await uia(p.x, p.y); uiaRuns.push({ at: [p.x, p.y], window: info, hitTestMs: Number(hitMs.toFixed(2)), uia: r }); console.log(`  ${info.class} (${info.title.slice(0, 40)}) -> UIA ${r.ok ? r.controlType + " '" + String(r.name).slice(0, 30) + "' in " + r.ms + " ms" : "FAILED " + r.error}`); }
      await sleep(60);
    }
    out.results.hitTests = uiaRuns;

    // 4. elevation
    console.log("\n[4/4] Elevated window. Open Notepad with 'Run as administrator', put it on screen, and hover it for 10 seconds now.");
    const t1 = now(); let elevated = null;
    while (now() - t1 < 10000) { const p = {}; GetCursorPos(p); const info = windowInfo(WindowFromPoint({ x: p.x, y: p.y })); if (info && /notepad/i.test(info.class + info.title)) { const r = await uia(p.x, p.y); elevated = { window: info, uia: r }; break; } await sleep(100); }
    out.results.elevatedProbe = elevated || { note: "no Notepad seen under the cursor; skipped" };

    out.notes.push("Nothing was clicked, typed, recorded or sent. Window titles are included above; delete any you do not want to share before pasting.");
  } catch (e) { out.error = String(e && e.stack || e); }
  const file = path.join(process.cwd(), "spike-results.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${file}. Paste its contents back (remove any window titles you consider private).`);
  app.quit();
});
