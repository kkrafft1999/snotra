# Electron development in Cursor — lessons and pitfalls

Things learned while building this project. None of these problems are obvious,
and each of them can cost a lot of time if you don't know about it.

---

## 1. The Electron-in-Cursor conflict (`ELECTRON_RUN_AS_NODE`)

### The problem

Cursor is an Electron app itself, and it sets the environment variable
`ELECTRON_RUN_AS_NODE=1` in its integrated terminal. That variable makes
Electron **not start as a GUI application**, but run as a plain Node.js process.
The result: no window, no dialog — the app simply appears to do nothing.

### The fix

The variable has to be removed explicitly in the `start` script:

```json
{
  "scripts": {
    "start": "unset ELECTRON_RUN_AS_NODE && electron ."
  }
}
```

### Why it happens

Cursor uses `ELECTRON_RUN_AS_NODE` so that its own internal Node processes work
correctly. Every child process in the terminal inherits the variable
automatically.

---

## 2. The `contextBridge.exposeInMainWorld` naming conflict (Electron 41+)

### The problem

From Electron 41 on, `contextBridge.exposeInMainWorld('electronAPI', ...)`
registers the given name as a **global constant** in the renderer scope.
Declaring the same name again leads to:

```
Uncaught SyntaxError: Identifier 'electronAPI' has already been declared
```

That error is **only visible in the DevTools console**, and it **silently blocks
the entire JavaScript file** — not a single event listener gets registered, no
button works.

### The fix

Use a **different variable name** in the renderer:

```javascript
// Right
const api = window.electronAPI;

// Wrong — causes a SyntaxError in Electron 41+
const { electronAPI } = window;
```

### A note

This only happens in newer Electron versions. Older tutorials and examples often
still use the destructuring variant, which works fine there.

---

## 3. A debugging strategy for "nothing happens at all"

### The problem

Errors in the renderer process (a SyntaxError in `app.js`, say) appear
**exclusively in the DevTools console**. Nothing of it shows up in the terminal
running `npm start`. The app seems to start normally, but buttons and other UI
elements don't react.

### The fix

Open DevTools the moment behaviour becomes inexplicable. Add this temporarily in
`main.js` after `loadFile`:

```javascript
mainWindow.webContents.openDevTools({ mode: 'detach' });
```

Then check the console for red error messages. Remove the line again once you
are done debugging.

### Debugging checklist

1. Open DevTools and check the console tab
2. Put a `console.log` at the top of the click handler — does the output arrive?
3. Add a `console.log` to the IPC handler in the main process — that output does
   appear in the terminal
4. Check the network tab to see whether the files (CSS, JS) load correctly

---

## Summary

| Symptom | Cause | Fix |
| --- | --- | --- |
| The app doesn't start as a GUI in the Cursor terminal | Cursor sets `ELECTRON_RUN_AS_NODE=1` | `unset ELECTRON_RUN_AS_NODE` in the start script |
| Buttons don't react, no visible errors | SyntaxError from a duplicate `electronAPI` declaration | `const api = window.electronAPI` instead of destructuring |
| Renderer errors are nowhere to be found | Renderer errors are only visible in DevTools | Enable `openDevTools()` temporarily |
