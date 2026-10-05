"""Paint-only Win32 indicator: no agent, input automation, network or credentials."""
import ctypes as c
from ctypes import wintypes as w
import json
import queue
import sys
import threading

u = c.WinDLL('user32', use_last_error=True)
g = c.WinDLL('gdi32', use_last_error=True)
k = c.WinDLL('kernel32', use_last_error=True)
u.SetProcessDpiAwarenessContext.argtypes = [c.c_void_p]
u.SetProcessDpiAwarenessContext(c.c_void_p(-4))
PROC = c.WINFUNCTYPE(c.c_ssize_t, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
class WNDCLASS(c.Structure):
    _fields_ = [('style', w.UINT), ('proc', PROC), ('classExtra', c.c_int), ('windowExtra', c.c_int),
                ('instance', w.HINSTANCE), ('icon', w.HICON), ('cursor', w.HANDLE),
                ('background', w.HBRUSH), ('menu', w.LPCWSTR), ('name', w.LPCWSTR)]
class PAINT(c.Structure):
    _fields_ = [('dc', w.HDC), ('erase', w.BOOL), ('rect', w.RECT), ('restore', w.BOOL),
                ('update', w.BOOL), ('reserved', c.c_byte * 32)]

def api(lib, name, result, args):
    fn = getattr(lib, name); fn.restype = result; fn.argtypes = args; return fn
api(k, 'GetModuleHandleW', w.HINSTANCE, [w.LPCWSTR])
api(u, 'DefWindowProcW', c.c_ssize_t, [w.HWND,w.UINT,w.WPARAM,w.LPARAM])
api(u, 'CreateWindowExW', w.HWND, [w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,c.c_int,c.c_int,c.c_int,c.c_int,w.HWND,w.HMENU,w.HINSTANCE,c.c_void_p])
api(u, 'RegisterClassW', w.ATOM, [c.POINTER(WNDCLASS)])
api(u, 'SetWindowPos', w.BOOL, [w.HWND,w.HWND,c.c_int,c.c_int,c.c_int,c.c_int,w.UINT])
api(u, 'SetLayeredWindowAttributes', w.BOOL, [w.HWND,w.DWORD,c.c_byte,w.DWORD])
api(u, 'SetWindowDisplayAffinity', w.BOOL, [w.HWND,w.DWORD])
api(u, 'GetWindowDisplayAffinity', w.BOOL, [w.HWND,c.POINTER(w.DWORD)])
api(u, 'GetWindowLongPtrW', c.c_ssize_t, [w.HWND,c.c_int])
api(u, 'GetWindowRect', w.BOOL, [w.HWND,c.POINTER(w.RECT)])
api(u, 'ShowWindow', w.BOOL, [w.HWND,c.c_int])
api(u, 'IsWindowVisible', w.BOOL, [w.HWND])
api(u, 'DestroyWindow', w.BOOL, [w.HWND])
api(u, 'PostMessageW', w.BOOL, [w.HWND,w.UINT,w.WPARAM,w.LPARAM])
api(u, 'SetTimer', c.c_size_t, [w.HWND,c.c_size_t,w.UINT,c.c_void_p])
api(u, 'BeginPaint', w.HDC, [w.HWND,c.POINTER(PAINT)])
api(u, 'EndPaint', w.BOOL, [w.HWND,c.POINTER(PAINT)])
api(u, 'FillRect', c.c_int, [w.HDC,c.POINTER(w.RECT),w.HBRUSH])
api(u, 'DrawTextW', c.c_int, [w.HDC,w.LPCWSTR,c.c_int,c.POINTER(w.RECT),w.UINT])
api(u, 'GetMessageW', w.BOOL, [c.POINTER(w.MSG),w.HWND,w.UINT,w.UINT])
api(u, 'TranslateMessage', w.BOOL, [c.POINTER(w.MSG)])
api(u, 'DispatchMessageW', c.c_ssize_t, [c.POINTER(w.MSG)])
api(g, 'CreateSolidBrush', w.HBRUSH, [w.DWORD])
api(g, 'CreatePen', w.HANDLE, [c.c_int,c.c_int,w.DWORD])
api(g, 'CreateFontW', w.HANDLE, [c.c_int,c.c_int,c.c_int,c.c_int,c.c_int,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.LPCWSTR])
api(g, 'SelectObject', w.HANDLE, [w.HDC,w.HANDLE])
api(g, 'DeleteObject', w.BOOL, [w.HANDLE])
api(g, 'SetBkMode', c.c_int, [w.HDC,c.c_int])
api(g, 'SetTextColor', w.DWORD, [w.HDC,w.DWORD])
for name in ('Ellipse','Rectangle','RoundRect'):
    api(g, name, w.BOOL, [w.HDC]+[c.c_int]*(6 if name=='RoundRect' else 4))
ENUM = c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
api(u, 'EnumWindows', w.BOOL, [ENUM,w.LPARAM])

rgb = lambda r,b,g_: r | b << 8 | g_ << 16
windows = []
visible = False
exclude = '--review' not in sys.argv
inbox = queue.Queue()
brushes = []
instance = k.GetModuleHandleW(None)
LABEL = '人格正在操控电脑哦'

def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)

def geometry():
    work = w.RECT()
    if not u.SystemParametersInfoW(0x30,0,c.byref(work),0): raise c.WinError(c.get_last_error())
    badge_x,badge_y = work.right-348-24, work.bottom-70-24
    @ENUM
    def avoid_toast(handle,_):
        nonlocal badge_y
        if handle in windows or not u.IsWindowVisible(handle) or not u.GetWindowLongPtrW(handle,-20)&8: return True
        rect=w.RECT();u.GetWindowRect(handle,c.byref(rect))
        if 120<=rect.right-rect.left<=650 and 80<=rect.bottom-rect.top<=450 and rect.right>=work.right-100 and rect.bottom>=work.bottom-100 and rect.top<=badge_y+70:
            badge_y=min(badge_y,rect.top-70-12)
        return True
    u.EnumWindows(avoid_toast,0)
    return ((badge_x,badge_y,348,70),)

def place():
    positions=geometry()
    for handle,bounds in zip(windows,positions):
        if not u.SetWindowPos(handle,w.HWND(-1),*bounds,0x10|0x40): raise c.WinError(c.get_last_error())

def show(value):
    global visible
    visible=value
    if value: place()
    else:
        for handle in windows: u.ShowWindow(handle,0)

def affinity(value):
    global exclude
    exclude=value
    for handle in windows:
        if not u.SetWindowDisplayAffinity(handle,0x11 if value else 0): raise c.WinError(c.get_last_error())

def status():
    actual=[]
    for handle in windows:
        value=w.DWORD();u.GetWindowDisplayAffinity(handle,c.byref(value))
        actual.append({'hwnd':int(handle),'extendedStyle':u.GetWindowLongPtrW(handle,-20),'visible':bool(u.IsWindowVisible(handle)),'captureAffinity':value.value})
    return {'visible':visible,'excludeCapture':exclude,'windows':actual,'geometry':geometry(),'label':LABEL,'indicatorOnly':True}

def paint_badge(handle):
    p=PAINT();dc=u.BeginPaint(handle,c.byref(p))
    objects=[]
    def brush(color):
        result=g.CreateSolidBrush(color);objects.append(result);return result
    old_brush=g.SelectObject(dc,brush(rgb(228,243,255)))
    pen=g.CreatePen(0,2,rgb(145,197,235));objects.append(pen);old_pen=g.SelectObject(dc,pen)
    u.FillRect(dc,c.byref(w.RECT(0,0,348,70)),brush(rgb(255,0,255)))
    g.RoundRect(dc,0,0,348,70,32,32)
    g.SelectObject(dc,brush(rgb(255,255,255)))
    g.Ellipse(dc,20,27,45,52);g.Ellipse(dc,31,15,63,49);g.Ellipse(dc,51,25,77,52)
    white_pen=g.CreatePen(0,1,rgb(255,255,255));objects.append(white_pen);g.SelectObject(dc,white_pen)
    g.Rectangle(dc,32,32,64,51)
    font=g.CreateFontW(-23,0,0,0,400,0,0,0,1,0,0,4,0,'Microsoft YaHei UI');objects.append(font);old_font=g.SelectObject(dc,font)
    g.SetBkMode(dc,1);g.SetTextColor(dc,rgb(54,123,176))
    u.DrawTextW(dc,LABEL,-1,c.byref(w.RECT(91,0,341,70)),0x20|0x4)
    g.SelectObject(dc,old_font);g.SelectObject(dc,old_pen);g.SelectObject(dc,old_brush)
    for obj in objects: g.DeleteObject(obj)
    u.EndPaint(handle,c.byref(p))

def drain():
    try:
        while not inbox.empty():
            command=inbox.get_nowait()
            if command.get('exit'):
                show(False)
                for handle in windows: u.DestroyWindow(handle)
                u.PostQuitMessage(0);return
            if 'excludeCapture' in command: affinity(bool(command['excludeCapture']))
            if 'visible' in command: show(bool(command['visible']))
            emit({'id':command.get('id'),**status()})
    except Exception as error:
        show(False);emit({'error':str(error)});u.PostQuitMessage(1)

@PROC
def window_proc(handle,message,wp,lp):
    if message==0x0f and windows and handle==windows[0]: paint_badge(handle);return 0
    if message==0x21: return 3  # MA_NOACTIVATE, even for non-client input.
    if message==0x84: return -1 # HTTRANSPARENT.
    if message==0x8001: drain();return 0
    if message==0x113:
        if visible: place()
        return 0
    return u.DefWindowProcW(handle,message,wp,lp)

for name,color in [('Persona desktop indicator',rgb(255,0,255))]:
    brush=g.CreateSolidBrush(color);brushes.append(brush)
    cls=WNDCLASS(0,window_proc,0,0,instance,None,None,brush,None,name)
    if not u.RegisterClassW(c.byref(cls)): raise c.WinError(c.get_last_error())
    handle=u.CreateWindowExW(0x080800a8,name,name,0x80000000,0,0,1,1,None,None,instance,None)
    if not handle: raise c.WinError(c.get_last_error())
    windows.append(handle)
u.SetLayeredWindowAttributes(windows[0],rgb(255,0,255),255,1)
affinity(exclude)
u.SetTimer(windows[0],1,500,None)
emit({'ready':True,**status()})

def read_commands():
    try:
        for line in sys.stdin:
            inbox.put(json.loads(line));u.PostMessageW(windows[0],0x8001,0,0)
    finally:
        inbox.put({'exit':True});u.PostMessageW(windows[0],0x8001,0,0)
threading.Thread(target=read_commands,daemon=True).start()
message=w.MSG()
while u.GetMessageW(c.byref(message),None,0,0)>0:
    u.TranslateMessage(c.byref(message));u.DispatchMessageW(c.byref(message))
for brush in brushes: g.DeleteObject(brush)
