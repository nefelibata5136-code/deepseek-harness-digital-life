from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
src = root / 'vendor/deepseek-harness/apps/desktop/src'
report = root / 'reports/multi-window/source-before'
report.mkdir(parents=True, exist_ok=True)

def edit(name, transform):
    p = src / name
    s = p.read_text(encoding='utf-8')
    (report / name).write_text(s, encoding='utf-8')
    p.write_text(transform(s), encoding='utf-8', newline='\n')

def main(s):
    assert 'const productWindows' not in s, 'Multi-window changes already applied; do not reapply initial transformation.'
    s = s.replace('  let mainWindow: BrowserWindow | undefined', '''  const productWindows = new Set<BrowserWindow>()
  const productWindowFor = (contents?: Electron.WebContents): BrowserWindow | undefined =>
    contents === undefined ? mainWindow : [...productWindows].find(window => !window.isDestroyed() && window.webContents === contents)
  let mainWindow: BrowserWindow | undefined''')
    s = s.replace('    assertDesktopSender(event, [\'app\'])\n    if (mainWindow', "    const mainWindow = productWindowFor(event.sender)\n    assertDesktopSender(event, ['app'])\n    if (mainWindow", 1)
    # IPC actions must resolve their sender, including background windows.
    channels = ['bootFailed', 'nativeThemeSet', 'localeBootstrap', 'localeChanged', 'onboardingActive', 'windowsMenu', 'windowsAppearance']
    for channel in channels:
        pattern = r"(ipcMain\.(?:handle|on)\(DESKTOP_IPC\." + channel + r", (?:async )?\(event[^\n]*\) => \{\n)"
        s, count = re.subn(pattern, r'\1    const mainWindow = productWindowFor(event.sender)\n', s)
        assert count == 1, channel
    s = s.replace('    const owner = mainWindow\n', '    const owner = productWindowFor(event.sender)\n')
    s = s.replace('details.webContentsId !== mainWindow?.webContents.id', '!([...productWindows].some(window => window.webContents.id === details.webContentsId))')
    s = s.replace('installDesktopDirectoryPicker(() => mainWindow)', 'installDesktopDirectoryPicker(productWindowFor)')
    s = s.replace('installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)', 'installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents, contents => productWindowFor(contents) !== undefined)')
    s = s.replace('installDesktopShortcuts(() => mainWindow,', 'installDesktopShortcuts(productWindowFor,')
    s = s.replace('    mainWindow = window\n    browserGuests.bind', '''    productWindows.add(window)
    mainWindow ??= window
    window.on('focus', () => { mainWindow = window })
    browserGuests.bind''')
    s = s.replace("      if (updateDialog.isOpen) { updateDialog.focus(); return }", "      if (updateDialog.isOpen) { updateDialog.focus(); return }\n      if (productWindows.size > 1) { window.destroy(); return }")
    s = s.replace("    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })", "    window.on('closed', () => {\n      productWindows.delete(window)\n      if (mainWindow === window) mainWindow = [...productWindows].at(-1)\n    })")
    anchor = '  const enterWorkspace = async '
    i = s.index(anchor)
    s = s[:i] + '''  const openNewWindow = async (): Promise<void> => {
    if (quitting || recovery.active || isMandatory() || !enteredWorkspace || backend.state.phase !== 'ready') return
    const window = createMainWindow()
    try {
      await window.loadURL(applicationUrl)
      if (quitting || isMandatory() || !enteredWorkspace || window.isDestroyed()) { if (!window.isDestroyed()) window.destroy(); return }
      window.show()
      window.focus()
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      console.error('desktop new window:', error)
    }
  }
''' + s[i:]
    s = s.replace('  const applicationItems = (): MenuItemConstructorOptions[] => [', '''  const newWindowItem = (): MenuItemConstructorOptions => ({
    label: currentDesktopLocale().messages.newWindow,
    accelerator: 'CommandOrControl+Shift+N',
    enabled: enteredWorkspace && backend.state.phase === 'ready' && !isMandatory(),
    click: () => { void openNewWindow() },
  })
  const applicationItems = (): MenuItemConstructorOptions[] => [
    newWindowItem(),
    { type: 'separator' },''')
    s = s.replace("Menu.buildFromTemplate(process.platform === 'win32' ? devToolsItems", "Menu.buildFromTemplate(process.platform === 'win32' ? [newWindowItem(), ...devToolsItems]")
    s = s.replace('    enteredWorkspace = true\n', '    enteredWorkspace = true\n    refreshApplicationMenu()\n')
    s = s.replace('      else mainWindow?.hide()', '      else for (const window of productWindows) window.hide()')
    s = s.replace('    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.hide()', '    for (const window of productWindows) if (!window.isDestroyed()) window.hide()')
    s = s.replace('          await navigateMain(applicationUrl)\n          if (backend.host', '          await Promise.all([...productWindows].map(window => window.loadURL(applicationUrl)))\n          if (backend.host')
    return s

def keyboard(s):
    s = s.replace('@param getWindow - current product window.', '@param getWindow - focused product window, or the owner of supplied contents.')
    s = s.replace('getWindow: () => BrowserWindow | undefined', 'getWindow: (contents?: WebContents) => BrowserWindow | undefined')
    s = s.replace('  let definitions:', '  const windows = new Set<BrowserWindow>()\n  let definitions:', 1)
    s = s.replace('    const window = getWindow()\n    if (window !== undefined && !window.isDestroyed() && window.webContents.mainFrame.url.startsWith', '    for (const window of windows) if (!window.isDestroyed() && window.webContents.mainFrame.url.startsWith')
    s = s.replace('    const window = getWindow()\n    if (window === undefined || window.isDestroyed() || event.sender', '    const window = getWindow(event.sender)\n    if (window === undefined || window.isDestroyed() || event.sender')
    s = s.replace('      definitions = []; keys.clear(); recording = false', '      if (windows.size > 1) return\n      definitions = []; keys.clear(); recording = false')
    s = s.replace('    const closed = (): void => { clear(); dispose() }', '    const closed = (): void => { clear(); windows.delete(window); dispose() }')
    s = s.replace('    attach(window) { attachInput(window, window.webContents) },', '    attach(window) { windows.add(window); attachInput(window, window.webContents) },')
    # Check actual attachment formatting before writing.
    if 'windows.add(window)' not in s:
        s = s.replace('      attachInput(window, window.webContents)', '      windows.add(window)\n      attachInput(window, window.webContents)')
    assert 'windows.add(window)' in s
    return s

edit('main.ts', main)
edit('keyboard.ts', keyboard)
edit('directory-picker.ts', lambda s: s.replace('type BrowserWindow', 'type BrowserWindow, type WebContents').replace('@param getWindow - Current local application window;', '@param getWindow - Owner of the requesting contents;').replace('getWindow: () => BrowserWindow | undefined', 'getWindow: (contents?: WebContents) => BrowserWindow | undefined').replace('const window = getWindow()', 'const window = getWindow(event.sender)'))
edit('microphone-permissions.ts', lambda s: s.replace(' * @param primary -', ' * @param owns - optional ownership check for additional product windows.\n * @param primary -').replace('primary: () => WebContents | undefined): void', 'primary: () => WebContents | undefined, owns: (contents: WebContents) => boolean = contents => contents === primary()): void').replace('contents != null && contents === primary()', 'contents != null && owns(contents)').replace('const allowed = contents === primary()', 'const allowed = owns(contents)'))
edit('locale.ts', lambda s: s.replace("  fileMenu: 'File',", "  fileMenu: 'File',\n  newWindow: 'New Window',").replace("  fileMenu: '文件',", "  fileMenu: '文件',\n  newWindow: '新建窗口',"))
print('Updated window ownership, menu, shortcuts, picker, microphone and localized copy.')
