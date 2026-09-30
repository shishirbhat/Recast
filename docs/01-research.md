# 01. Research summary (verified 2026-09-30)

Method: web search plus page fetches. Each claim is tagged **[primary]** (vendor page I fetched), **[secondary]** (search result summary or third-party article only) or **[unverified]** (from my own background knowledge, not checked today). Anything tagged secondary or unverified should be re-checked before it carries weight in a design.

## Findings that change the design

### Apple: App Intents, App Entities, on-screen awareness (WWDC26, iOS/macOS 27)
- **On-screen awareness is real but system-only.** The View Annotations API (`.appEntityIdentifier(...)`, collection and canvas variants, `NSUserActivity`) exists so *Siri and the system* can resolve "that one". WWDC26 session 343 gives no route for a third-party app to read another app's annotations. [primary: developer.apple.com/videos/play/wwdc2026/343]
- **Consequence:** Recast cannot use on-screen awareness as a capture source on Apple platforms. It can only (a) publish its own App Entities/intents so Siri/Shortcuts can hand things to Recast, and (b) consume what the *user* explicitly shares.
- **Useful find:** WWDC26 session 345 shows `Transferable` entities with `ValueRepresentation(exporting:)`, e.g. an entity exported as `PlaceDescriptor` that Maps understands. This is Apple's own "typed payload across apps" mechanism, and it matches Recast's Location object well. [primary: .../wwdc2026/345]
- Session 345 also adds `EntityCollection`, `SyncableEntity`, `LongRunningIntent` (beyond the 30s limit) and `ExecutionTargets`. [primary]
- Not verified: minimum OS versions per API (session 343 does not state them).

### Android: AppFunctions (and "Android MCP")
- Status is **experimental preview**, not GA. Gemini integration is "private preview with trusted testers" (as of May 2026). [primary: developer.android.com/ai/appfunctions]
- **Sources disagree on the minimum OS.** The docs page says Android 16+ (`@RequiresApi(36)`). The July 2026 Android Developers Blog post says Android 17 or newer and shows Jetpack `1.0.0-alpha10`. [primary, conflicting] I would plan for 17 until Google reconciles this.
- **Callers are gated.** A caller needs the `EXECUTE_APP_FUNCTIONS` permission, and "only a limited number of apps and system agents can access the entire pipeline." The July post says only privileged system agents registered with the intelligence system can invoke functions. [primary]
- **Consequence:** a third-party app like Recast cannot count on calling other apps' AppFunctions in v1. Layer 3 on Android should be built on share targets and intents, with AppFunctions as a watched future capability, not a dependency. The "Android MCP" framing is Google's description of AppFunctions (on-device, MCP-like), not a separate protocol I could find. I did not read the AEP "Android MCP" guideline page. [secondary]

### MCP
- The 2026-07-28 spec release candidate makes the protocol stateless (no `initialize` handshake or session id), hardens OAuth (RFC 9207 `iss`), and moves Tasks to an extension. Roots, Sampling and Logging are deprecated. [primary: blog.modelcontextprotocol.io]
- Consequence: any Recast MCP bridge should target the RC's stateless model, and should not depend on Sampling or Roots.

### Browser extensions
- **Chrome MV3:** no persistent background; the service worker is torn down when idle; DOM work has to go through offscreen documents or content scripts; no remotely hosted code; native messaging can keep the worker alive beyond the normal 5 minute window. [primary: developer.chrome.com known-issues page.] The "~30s idle" figure is from third-party articles. [secondary]
- **Consequence for Recast:** capture must run in **content scripts** (they own the DOM) and keep state in `chrome.storage.session`/IndexedDB, never in worker memory. Extraction accuracy must not depend on a long-lived worker.
- **Edge:** takes Chrome MV3 extensions largely as-is. Microsoft's blog says consumer MV2 to MV3 transition starts August 2026 and 95% of top extensions have moved. New MV2 submissions have been closed since 2022. [secondary: search snippets of blogs.windows.com and learn.microsoft.com; I did not fetch them]
- **Safari:** extension must ship inside an app; requires paid Apple Developer Program membership; App Store Connect can now convert an uploaded ZIP without a Mac. Not all MV3 features map 1:1. [primary for packaging/membership, generic for the parity claim]. Firefox was not researched.

### macOS Accessibility and hardened runtime
- Accessibility is a TCC permission (`AXIsProcessTrusted` / `...WithOptions` to prompt). A `CGEventTap` with `defaultTap` needs Accessibility, `listenOnly` needs Input Monitoring. `AXIsProcessTrusted` results are cached per process, so a re-signed or updated app can report stale state until relaunch. [secondary: several developer write-ups]
- Wispr Flow's own docs confirm the pattern we are copying: macOS needs Accessibility (plus a separate helper binary that holds permissions); **Windows Flow needs only microphone access**. [primary: docs.wisprflow.ai]
- **Dead end:** Apple's page for the `com.apple.security.accessibility` entitlement returned 404, and one secondary source claims it is needed under hardened runtime. I could not verify that. My working belief, from prior knowledge [unverified]: a non-sandboxed, notarized Developer ID app uses the TCC prompt and needs no special entitlement; a sandboxed Mac App Store app cannot drive other apps' accessibility trees at all. So macOS Recast would have to ship outside the Mac App Store.

### Windows UI Automation
- Chromium ships native UIA by default since **Chrome 138** (legacy policy escape hatch until Chrome 146). [primary: developer.chrome.com/blog/windows-uia-support-update]
- **Trap:** Chromium and Electron do not build their accessibility tree until they detect an assistive-technology client, and that detection keys off the screen-reader COM contract, not plain UIA calls. A UIA client that just asks for the element under the pointer may see only window chrome. Workarounds exist (`WM_GETOBJECT`/`OBJID_CLIENT` probing, Electron `setAccessibilitySupportEnabled`). [secondary: the search summary quoting a project's notes; consistent with the Chrome blog]
- **Consequence:** on Windows, for browser content use the **extension** (DOM), not UIA. UIA is for native apps (Office, Explorer, Win32/WinUI). For Electron apps you get either a tree woken by the workaround, or nothing.
- Not researched: Windows low-level hooks vs `SetWinEventHook` for the lift key; overlay window click-through mechanics; UIPI (elevated windows can't be hit-tested or dropped onto from a non-elevated process) [unverified, but well known].

### UniFFI
- v0.31.0 released 2026-01-14 (docs.rs). Production-grade Swift and Kotlin generation; used across Firefox mobile and desktop; explicitly "a long way from 1.0", with occasional breaking changes on upgrade. [secondary: repo README and docs.rs snippets]

### iOS cross-app drag
- **iPad:** cross-app drag since iOS 11. **iPhone:** cross-app drag arrived in **iOS 15**, in practice a long-press-then-second-finger gesture. [secondary: MacRumors, Cult of Mac and others, not Apple docs]
- Custom types travel via `NSItemProvider`; whether an arbitrary custom UTType survives iPhone cross-app drag in practice is **unverified**. Apple's doc page I tried returned nothing useful.
- **Consequence:** mobile design should not lean on drag. LIFT via share extension/App Intent, tray, PLACE from the destination side, exactly as the brief says. Adopt `Transferable` where the destination is Apple-native.
- iOS share extensions have a **120 MB memory limit** and are killed when exceeded. [secondary: multiple developer reports]. Real, but it matters only at Layer 3.

## Sources I could not reach or did not verify
- Apple's entitlement docs (404) and Apple's own drag-and-drop docs (empty result).
- Firefox extension parity, Safari MV3 feature gaps, Edge Add-ons policy text (search snippets only).
- Gmail/Calendar/Sheets OAuth scope classification and Google verification requirements. This matters for Layer 2 timing and I have **not** checked it. It is the first thing to verify at the start of Layer 2.
- Google Scholar `citation_*` tag conventions (relied on background knowledge; the fixture corpus will test it empirically).
- Windows hook/overlay behaviour. To be prototyped, not researched.
