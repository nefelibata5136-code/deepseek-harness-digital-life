/** Codex advice runs use a separate login/configuration home and disposable work area. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const name = 'persona-codex-advisor';
export const inject = ['subagents'];
export const ADVISOR_CONFIG = 'sandbox_mode = "read-only"\napproval_policy = "never"\n'
  + '[features]\napps = false\nplugins = false\nbrowser_use = false\ncomputer_use = false\n'
  + 'memories = false\nmulti_agent = false\nhooks = false\n'
  + '[mcp_servers.codex_apps]\ncommand = "disabled-codex-apps"\nenabled = false\n';
const execFileAsync = promisify(execFile);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

async function regularDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
    throw new Error('CODEX_ADVISOR_UNSAFE_DIRECTORY');
}

async function atomic(path, bytes) {
  const temp = path + '.' + randomUUID() + '.tmp';
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close(); file = undefined;
    await rename(temp, path);
  } finally {
    await file?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Restrict the new delegated login home; never changes the user's Codex directory. */
async function protectLoginHome(home) {
  if (process.platform !== 'win32') return;
  const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('CODEX_ADVISOR_IDENTITY_UNAVAILABLE');
  await execFileAsync('icacls.exe', [home, '/inheritance:r', '/grant:r',
    '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
}

/**
 * Wrap an official one-shot provider without replacing its process or model implementation.
 * @param raw Official provider registered under the deployment's private name.
 * @param config Trusted protectedRoot and optional authSource for offline fixtures.
 * @returns The public codex provider plus paths for deployment configuration.
 */
export function createCodexAdvisor(raw, config) {
  const protectedRoot = resolve(config.protectedRoot);
  const home = join(protectedRoot, 'codex-home');
  const workRoot = join(protectedRoot, 'advisor-work');
  const authSource = resolve(config.authSource ?? join(homedir(), '.codex', 'auth.json'));
  if (inside(home, authSource)) throw new Error('CODEX_ADVISOR_AUTH_SOURCE_OVERLAP');
  let queue = Promise.resolve();
  const externalSkillRoot = join(dirname(dirname(authSource)), '.agents', 'skills');
  const prepareHome = () => {
    let step = 'directory';
    const task = queue.catch(() => {}).then(async () => {
      await regularDirectory(protectedRoot);
      await regularDirectory(home);
      step = 'permissions';
      await protectLoginHome(home);
      step = 'configuration';
      const disabled = new Set();
      try {
        for (const entry of await readdir(externalSkillRoot)) {
          const path = join(externalSkillRoot, entry);
          try {
            if ((await lstat(join(path, 'SKILL.md'))).isFile()) {
              disabled.add(path);
              disabled.add(await realpath(path));
              disabled.add(join(path, 'SKILL.md'));
              disabled.add(await realpath(join(path, 'SKILL.md')));
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const configText = ADVISOR_CONFIG
        + '[skills]\nconfig = [' + [...disabled].map(path => '{ path = ' + JSON.stringify(path) + ', enabled = false }').join(', ') + ']\n';
      await atomic(join(home, 'config.toml'), Buffer.from(configText));
      step = 'source-login';
      const stat = await lstat(authSource);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('CODEX_ADVISOR_LOGIN_UNAVAILABLE');
      let auth;
      try {
        auth = await readFile(authSource);
        if (auth.length > 1024 * 1024) throw new Error('CODEX_ADVISOR_LOGIN_UNAVAILABLE');
        JSON.parse(auth.toString('utf8'));
        const digest = createHash('sha256').update(auth).digest('hex');
        const marker = join(home, '.source-auth.sha256');
        let previous;
        try { previous = await readFile(marker, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        let targetExists = false;
        try {
          const target = await lstat(join(home, 'auth.json'));
          if (!target.isFile() || target.isSymbolicLink()) throw new Error('CODEX_ADVISOR_LOGIN_UNAVAILABLE');
          targetExists = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Preserve any official token refresh performed in the isolated home.
        // Synchronize again only when the user's source login actually changed.
        if (previous !== digest || !targetExists) {
          step = 'login-copy';
          await atomic(join(home, 'auth.json'), auth);
          await atomic(marker, Buffer.from(digest));
        }
      } finally { auth?.fill(0); }
    }).catch(() => { throw new Error('CODEX_ADVISOR_LOGIN_HOME_UNAVAILABLE:' + step); });
    queue = task;
    return task;
  };
  const provider = {
    name: config.providerName ?? 'codex',
    capabilities: raw.capabilities,
    inheritsParentContext: false,
    async start(request) {
      request.signal.throwIfAborted();
      const originalCwd = request.parent.session.header.cwd;
      if (!originalCwd || inside(resolve(originalCwd), protectedRoot) || inside(protectedRoot, resolve(originalCwd)))
        throw new Error('CODEX_ADVISOR_WORKSPACE_OVERLAP');
      await regularDirectory(protectedRoot);
      await regularDirectory(workRoot);
      const stage = join(workRoot, randomUUID());
      await regularDirectory(stage);
      await prepareHome();
      request.signal.throwIfAborted();
      // Official CodexProvider reads only this header cwd. Preserve the real
      // delegator on the Harness-owned outer run and its result catalog.
      const session = Object.create(request.parent.session);
      Object.defineProperty(session, 'header', { value: { ...request.parent.session.header, cwd: stage } });
      const parent = Object.create(request.parent);
      Object.defineProperty(parent, 'session', { value: session });
      const prompt = [{ type: 'text', text:
        '你是工具或顾问，没有人格身份和正式发言权。只返回建议、结果或报告；不得把它们称为人格的意志、记忆、心境或第一人称承诺。'
        + '本次是只读顾问运行，不能修改任何文件。代码与改动方案请完整返回，由在场的人格决定是否实际应用。不要尝试修改人格的核心、长期记忆、Skills、私人空间或任何外部文件。'
        + '所有结果由在场的人格决定是否吸收。工作目录：' + stage }, ...request.prompt];
      const run = await raw.start({ ...request, parent, prompt });
      return {
        ...run,
        result: run.result.then(result => ({
          ...result,
          output: [...result.output, { type: 'text', text: JSON.stringify({
            source: 'advisor', authoritative: false, workDirectory: stage,
            disposition: 'pending; only the current Persona seat can accept these results',
          }) }],
        })),
        dispose: () => run.dispose(),
      };
    },
  };
  return { provider, home, workRoot };
}

/** Register the public adviser over the official deployment-named Codex provider. */
export function apply(ctx, config) {
  const rawName = config.nativeProviderName ?? 'codex-native';
  let unregister;
  const mount = raw => {
    if (raw.name !== rawName || unregister) return;
    const advisor = createCodexAdvisor(raw, config);
    unregister = ctx.subagents.registerProvider(advisor.provider);
  };
  ctx.on('subagent/provider-added', mount);
  ctx.on('subagent/provider-removed', providerName => {
    if (providerName !== rawName) return;
    unregister?.(); unregister = undefined;
  });
  ctx.effect(() => () => { unregister?.(); unregister = undefined; }, 'persona codex advisor registration');
  const raw = ctx.subagents.getProvider(rawName);
  if (raw) mount(raw);
}
