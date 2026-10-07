import './windows-dpi.mjs';
import assert from 'node:assert/strict';
import { createDesktopOverlay } from './desktop-overlay.mjs';
import koffi from 'koffi';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const report=resolve(import.meta.dirname,'../../reports/windows_computer');
const user=koffi.load('user32.dll');
const foreground=user.func('intptr_t __stdcall GetForegroundWindow()');
const pointType=koffi.struct('OverlayPOINT',{x:'long',y:'long'});
const windowFromPoint=user.func('intptr_t __stdcall WindowFromPoint(OverlayPOINT point)');
const before=foreground();
const overlay=await createDesktopOverlay();
try {
  assert(!overlay.status().visible);
  await overlay.show();
  const active=overlay.status();
  assert.equal(active.indicatorOnly,true);
  assert.equal(active.windows.length,1,'Only the corner badge may be created');
  assert.equal(active.label,'人格正在操控电脑哦');
  assert.deepEqual(active.geometry[0].slice(2),[348,70],'No full-screen filter window');
  assert.equal(foreground(),before,'Indicator must not steal keyboard focus');
  for(const window of active.windows){
    assert(window.visible);
    assert.equal(window.extendedStyle & 0x080800a8,0x080800a8);
    assert.equal(window.captureAffinity,17);
  }
  for(const [x,y] of [[500,500],[active.geometry[0][0]+130,active.geometry[0][1]+30]]){
    assert(!active.windows.some(w=>w.hwnd===windowFromPoint({x,y})),'Mouse hit testing must pass through the badge');
  }
  // Review capture intentionally includes the otherwise excluded indicator.
  await overlay.captureForReview();
  await new Promise(resolve=>setTimeout(resolve,350));
  const screenshot=spawnSync('python',['-X','utf8','-c',
    'from PIL import ImageGrab; import sys; ImageGrab.grab(include_layered_windows=True).save(sys.argv[1])',resolve(report,'desktop-overlay.png')],
    {windowsHide:true,encoding:'utf8'});
  assert.equal(screenshot.status,0,screenshot.stderr);
  await overlay.restoreCaptureExclusion();
  await overlay.hide();
  assert(overlay.status().windows.every(w=>!w.visible));
  assert.equal(foreground(),before);
  const result={passed:true,observedAt:new Date().toISOString(),active,
    foregroundPreserved:true,mouseHitTestingPassesThrough:true,captureAffinityVerified:true,
    hiddenAfterStop:true,paidModelCalls:0};
  await writeFile(resolve(report,'overlay-validation.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await overlay.dispose();}
