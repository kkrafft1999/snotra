'use strict';

/**
 * A Windows Job Object for each run of the shell or Python runner (#991).
 *
 * On POSIX a run's processes share a process group, and `child-run` ends the
 * group once the shell has exited. Windows has no such group: once the shell
 * is gone, nothing points from it to what it started, and a process put into
 * the background outlived the run, the time limit and the app. A Job Object
 * is the Windows way to hold a process tree together — and with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` it ends the whole tree as soon as the
 * last handle to it closes.
 *
 * Node cannot create one, and a native addon for three calls is not worth a
 * dependency. So the process that is started puts itself into a new job
 * before it runs anything of the command's: PowerShell through a P/Invoke
 * type built with Reflection.Emit (`Add-Type` would compile C# on every run,
 * seconds instead of milliseconds), Python through `ctypes`. Every process it
 * starts from then on is in the job — including `Start-Process`, `start` and
 * `subprocess.Popen(..., creationflags=DETACHED_PROCESS)` — and it holds the
 * only handle, which is not inheritable. When it exits, the handle closes and
 * Windows ends whatever is left, before `child-run` counts the run as done.
 *
 * Breakaway is not allowed: a child that asks for `CREATE_BREAKAWAY_FROM_JOB`
 * is refused. The job is the immediate job of everything in it, so the outer
 * job libuv puts every child into (which allows silent breakaway) does not
 * let anything out either — breakaway is decided by the innermost job.
 *
 * What the job cannot hold is what Windows starts on the command's behalf in
 * another process: a scheduled task, a service, a COM server such as an
 * Office application. Where the job cannot be made at all (PowerShell in
 * Constrained Language Mode, say, or `cmd.exe` as the shell), the command
 * still runs as before, and a note in its error output says that the
 * background is not contained.
 */

/** What a run says when its processes could not be put into a job. */
const NOTICE = [
  '<background_processes>',
  'Snotra could not hold the processes of this run together on Windows, so a process the command',
  'leaves running in the background keeps running after the run ends.',
  '</background_processes>',
].join(' ');

/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9) as raw bytes: 144 bytes in a
 * 64-bit process, 112 in a 32-bit one. Only `LimitFlags` at offset 16 is set,
 * to KILL_ON_JOB_CLOSE (0x2000) — little endian, so byte 17 is 0x20.
 */
const JOB_INFO_CLASS = 9;
const KILL_ON_JOB_CLOSE = 0x2000;

const NATIVE = [
  ['CreateJobObjectW', '[IntPtr]', '[IntPtr], [IntPtr]'],
  ['SetInformationJobObject', '[bool]', '[IntPtr], [int], [byte[]], [int]'],
  ['AssignProcessToJobObject', '[bool]', '[IntPtr], [IntPtr]'],
];

/**
 * One line in front of the command — its own lines move down by one, nothing
 * else changes —, in a script block of its own, so that none of its variables
 * reach the command, and silent unless it fails. On the Windows CI runner it
 * adds about 45 ms to a Windows PowerShell start and nothing measurable to
 * PowerShell 7.
 */
const POWERSHELL_JOB = [
  '& { try {',
  "$t = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('SnotraRunJob'), 'Run')"
    + ".DefineDynamicModule('SnotraRunJob').DefineType('SnotraRunJob', 'Public, Abstract, Sealed');",
  ...NATIVE.map(([name, returns, params]) => `$t.DefinePInvokeMethod('${name}', 'kernel32.dll', `
    + `'Public, Static, PinvokeImpl', 'Standard', ${returns}, [Type[]]@(${params}), 'Winapi', 'Unicode')`
    + ".SetImplementationFlags('PreserveSig');"),
  '$k = $t.CreateType();',
  '$j = $k::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero);',
  '$n = if ([IntPtr]::Size -eq 8) { 144 } else { 112 };',
  `$b = [byte[]]::new($n); $b[17] = ${KILL_ON_JOB_CLOSE >> 8};`,
  `if ($j -eq [IntPtr]::Zero -or -not $k::SetInformationJobObject($j, ${JOB_INFO_CLASS}, $b, $n)`
    + ' -or -not $k::AssignProcessToJobObject($j, [IntPtr]::new(-1))) { throw }',
  `} catch { try { [Console]::Error.WriteLine('${NOTICE}'); $Error.Clear() } catch { } } }`,
].join(' ');

/**
 * `using` has to come before every other statement of a script, so the job
 * goes behind the command's own `using` lines — and the comments and blank
 * lines between them — instead of in front of them.
 */
const LEADING_USING = /^(?:\s|#[^\r\n]*|<#[\s\S]*?#>|using[ \t]+(?:namespace|module|assembly)[ \t]+(?:'[^']*'|"[^"]*"|[^\s;]+)[ \t]*;?)*/i;

/**
 * A PowerShell script that first puts its own process into a job.
 *
 * @param {string} script  the command as the user approved it
 * @returns {string}
 */
function withPowerShellJob(script) {
  const text = String(script);
  const head = /\busing\b/i.test(text) ? (text.match(LEADING_USING)?.[0] ?? '') : '';
  return `${head}${head && !head.endsWith('\n') ? '\n' : ''}${POWERSHELL_JOB}\n${text.slice(head.length)}`;
}

/**
 * The Python side: a small first interpreter that makes the job, puts itself
 * into it and then runs the real one — the same executable with the same
 * arguments — as its child, with the same standard handles. The script then
 * runs exactly as it ran before (its `sys.argv`, `sys.path`, tracebacks); the
 * price is a second interpreter start, about 50 ms on the Windows CI runner.
 * The empty entry `-c` puts in front of `sys.path` goes first, so a
 * `subprocess.py` in the workspace is not what gets imported here.
 */
const PYTHON_JOB = [
  'import sys',
  "sys.path[:] = [p for p in sys.path if p]",
  'import ctypes, struct, subprocess',
  'try:',
  "    k = ctypes.WinDLL('kernel32', use_last_error=True)",
  '    k.CreateJobObjectW.restype = ctypes.c_void_p',
  '    k.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_void_p)',
  '    k.SetInformationJobObject.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)',
  '    k.AssignProcessToJobObject.argtypes = (ctypes.c_void_p, ctypes.c_void_p)',
  '    k.GetCurrentProcess.restype = ctypes.c_void_p',
  '    job = k.CreateJobObjectW(None, None)',
  '    size = 144 if ctypes.sizeof(ctypes.c_void_p) == 8 else 112',
  '    limits = ctypes.create_string_buffer(size)',
  `    struct.pack_into('<I', limits, 16, ${KILL_ON_JOB_CLOSE})`,
  `    if not (job and k.SetInformationJobObject(job, ${JOB_INFO_CLASS}, limits, size)`
    + ' and k.AssignProcessToJobObject(job, k.GetCurrentProcess())):',
  '        raise OSError(ctypes.get_last_error())',
  'except Exception:',
  `    sys.stderr.write('${NOTICE}\\n')`,
  '    sys.stderr.flush()',
  'code = subprocess.call([sys.executable] + sys.argv[1:], stdin=0, stdout=1, stderr=2)',
  // An exit code above 2^31 (a crash: 0xC0000005) does not fit a C long on
  // Windows; the negative twin has the same 32 bits.
  'sys.exit(code - (1 << 32) if code >= 1 << 31 else code)',
].join('\n');

/**
 * The note behind the error output of a run no job holds: `cmd.exe`, the last
 * fallback, cannot make one.
 *
 * @param {string} stderr
 * @returns {string}
 */
function noteUncontained(stderr) {
  const text = String(stderr ?? '');
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${NOTICE}\n`;
}

/**
 * The interpreter arguments that run `pythonArgs` inside a job.
 *
 * @param {string[]} pythonArgs  what follows the interpreter otherwise, e.g. `['-B', '-u', script]`
 * @returns {string[]}
 */
function pythonJobArgs(pythonArgs) {
  return ['-B', '-c', PYTHON_JOB, ...pythonArgs];
}

module.exports = { withPowerShellJob, pythonJobArgs, noteUncontained, POWERSHELL_JOB, PYTHON_JOB, NOTICE };
