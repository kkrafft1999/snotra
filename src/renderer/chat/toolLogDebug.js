// Diagnose-Puffer des Tool-Logs (Issue #87) — eine Instanz je Renderer.
//
// Eigenes Modul, weil beide Seiten ihn brauchen: die Ansicht (toolLogView.js)
// schreibt beim Abgleich des Einzeilers hinein, ChatStream.js beim Empfang der
// Chat-Ereignisse und beim Export. Ein gemeinsamer Import spart es, den Puffer
// durch jede Signatur zu reichen.
import { createToolLogDebug } from '../utils/tool-log-debug.js';

// In den DevTools per window.__snotraToolLogDebug.serialize() abrufbar,
// im Chat per Strg/Cmd+Shift+D in die Zwischenablage (Issue #87).
export const toolLogDebug = createToolLogDebug();
if (typeof window !== 'undefined') window.__snotraToolLogDebug = toolLogDebug;
