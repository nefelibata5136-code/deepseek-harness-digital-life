// Must evaluate before Harness/native desktop libraries read Windows coordinates.
import koffi from 'koffi';

export let windowsDpi;
if (process.platform === 'win32') {
  const user = koffi.load('user32.dll');
  const set = user.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
  const current = user.func('intptr_t __stdcall GetThreadDpiAwarenessContext()');
  const awareness = user.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t value)');
  const metrics = user.func('int __stdcall GetSystemMetrics(int index)');
  const initialized = set(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  if (awareness(current()) !== 2) throw new Error('Host must use physical desktop pixels before enabling Windows input');
  windowsDpi = {initialized, awareness:'per-monitor', physicalScreen:{width:metrics(0),height:metrics(1)}};
}
