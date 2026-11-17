import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { OpenClawBeforeToolCallEvent } from './host-api.js'
import { nodeMayBeSymbolicLink, nodeRealpath, patchTargetsOf, spawnsOutsideTheWorkspace, writesIntoOpenClaw, type OpenClawStateLocations, type WriteGuardSystem } from './protected-writes.js'

let root = ''
let home = ''
let state = ''
let workspace = ''
let project = ''
let locations: OpenClawStateLocations
let system: WriteGuardSystem

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pushary-openclaw-writes-'))
  home = join(root, 'home')
  state = join(home, '.openclaw')
  workspace = join(state, 'workspace')
  project = join(root, 'project')
  for (const directory of [workspace, join(state, 'hooks', 'x'), join(home, '.pushary', 'openclaw-plugin'), join(project, 'src')]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(state, 'openclaw.json'), '{}')
  locations = {
    stateDirectories: [state],
    configFiles: [join(state, 'openclaw.json')],
    protectedTrees: [join(home, '.pushary'), join(home, '.config', 'openclaw')],
    serviceFiles: [
      { directory: join(home, 'Library', 'LaunchAgents'), namePrefix: 'ai.openclaw' },
      { directory: join(home, '.config', 'systemd', 'user'), namePrefix: 'openclaw' },
    ],
  }
  system = { osHome: home, realpath: nodeRealpath, mayBeSymbolicLink: nodeMayBeSymbolicLink, caseInsensitive: false, workspaceFor: () => workspace, otherWorkingDirectories: [] }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (path: unknown): OpenClawBeforeToolCallEvent => ({ toolName: 'write', params: { path, content: 'x' } })
const edit = (path: unknown): OpenClawBeforeToolCallEvent => ({ toolName: 'edit', params: { path, edits: [{ oldText: 'a', newText: 'b' }] } })
const patch = (text: string, derivedPaths?: readonly string[]): OpenClawBeforeToolCallEvent => ({
  toolName: 'apply_patch',
  params: { input: text },
  ...(derivedPaths === undefined ? {} : { derivedPaths }),
})

const asks = (event: OpenClawBeforeToolCallEvent, guard: WriteGuardSystem = system, where: OpenClawStateLocations = locations): boolean =>
  writesIntoOpenClaw(where, guard, { toolId: event.toolName, event, agentId: undefined })

describe('every write inside OpenClaw state asks, outside the agent workspace', () => {
  for (const relative of ['openclaw.json', '.env', join('hooks', 'x', 'handler.js'), join('conf', 'agents.json5'), join('state', 'openclaw.sqlite'), join('extensions', 'pushary', 'dist', 'index.js'), join('plugins', 'catalog.json'), join('agents', 'main', 'agent', 'auth.json'), join('workspace-other', 'notes.md')]) {
    it(`gates ${relative}`, () => assert.equal(asks(write(join(state, relative))), true))
  }

  it('gates the gateway.env fallback, the Pushary folder and the gateway service files', () => {
    assert.equal(asks(edit('~/.config/openclaw/gateway.env')), true)
    assert.equal(asks(write('~/.pushary/config.json')), true)
    assert.equal(asks(write('~/.pushary/openclaw-plugin/dist/index.js')), true)
    assert.equal(asks(write('~/Library/LaunchAgents/ai.openclaw.gateway.plist')), true)
    assert.equal(asks(write('~/.config/systemd/user/openclaw-gateway.service')), true)
    assert.equal(asks(write('~/.config/systemd/user/openclaw-gateway.service.d/override.conf')), true)
  })

  it('lets other service files and config folders through', () => {
    assert.equal(asks(write('~/Library/LaunchAgents/com.example.agent.plist')), false)
    assert.equal(asks(write('~/.config/systemd/user/backup.service')), false)
    assert.equal(asks(write('~/.config/nvim/init.lua')), false)
  })

  it('gates a config file OPENCLAW_CONFIG_PATH moved out of the state directory', () => {
    const moved = { ...locations, configFiles: [join(root, 'etc', 'claw.json')] }
    assert.equal(asks(write(join(root, 'etc', 'claw.json')), system, moved), true)
  })

  it('gates the hooks folder inside the workspace, which OpenClaw can load as code', () => {
    assert.equal(asks(write(join(workspace, 'hooks', 'x', 'handler.js'))), true)
    assert.equal(asks(write(join('hooks', 'x', 'handler.js'))), true)
  })

  it('asks for any path that is not plain, which OpenClaw resolves differently in each setup', () => {
    for (const path of [
      `file://${join(project, 'src', 'a.ts')}`,
      ' /../hooks/x.js', '\t/../hooks/x.js', '\v/../hooks/x.js', '\u00a0/../hooks/x.js', '\u2028//../hooks/x.js', '\ufeff/./../hooks/x.js', ' ~/../hooks/x.js', ' /../../openclaw.json',
      'hooks/.. ', '.openclaw/.. ',
      '.env<//arg_value>>', '.env</./arg_value>>', '.env</x/../arg_value>>', '@.env<//arg_value>>',
      'file:///../hooks/x%5C.js', 'file:///../.openclaw/extensions/p/index%5C.js',
      'notes:stream.txt', 'a%20b.txt',
    ]) {
      assert.equal(asks(write(path)), true, JSON.stringify(path))
      assert.equal(asks(edit(path)), true, JSON.stringify(path))
    }
    for (const path of ['src/app.ts', 'C:\\repo\\src\\app.ts', '~/notes (draft).md', 'docs/café.md', '@scope/pkg/index.ts', 'src/../lib/a.ts']) {
      assert.equal(asks(write(path)), false, JSON.stringify(path))
    }
  })

  it('gates a file URL that OpenClaw reads as a relative path and that climbs into protected places', () => {
    for (const path of ['FILE:///../hooks/x.js', 'File:///a/../../hooks/x.js', 'FILE://localhost/../../hooks/x.js', ' file:///../hooks/x.js', '\tfile:///../hooks/x.js', 'FILE:///../../openclaw.json', 'FILE:///../hooks/x.js</arg_value>>/</arg_value>>']) {
      assert.equal(asks(write(path)), true, JSON.stringify(path))
      assert.equal(asks(edit(path)), true, JSON.stringify(path))
    }
  })

  it('gates a file URL into OpenClaw state whatever the case of its scheme, as OpenClaw decodes it', () => {
    for (const scheme of ['file://', 'FILE://', 'File://']) {
      assert.equal(asks(write(`${scheme}${join(workspace, 'hooks', 'x', 'handler.js')}`)), true, scheme)
      assert.equal(asks(edit(`${scheme}${join(state, 'openclaw.json')}`)), true, scheme)
    }
  })

  it('gates the workspace .openclaw folder, where OpenClaw finds workspace plugins before the installed ones, in every spelling', () => {
    const pluginFile = join('.openclaw', 'extensions', 'pushary', 'index.js')
    assert.equal(asks(write(join(workspace, pluginFile))), true)
    assert.equal(asks(write(`~/.openclaw/workspace/${pluginFile}`)), true)
    assert.equal(asks(write(pluginFile)), true)
    assert.equal(asks(write(join(workspace, '.openclaw', 'extensions', 'pushary', 'openclaw.plugin.json'))), true)
    assert.equal(asks(edit(join(workspace, '.openclaw', 'openclaw.json'))), true)
    assert.equal(asks(patch(`*** Begin Patch\n*** Add File: ${join(workspace, pluginFile)}\n+export default {}\n*** End Patch`)), true)
  })

  it('gates the workspace .openclaw folder when the workspace sits outside the state directory', () => {
    const outside = { ...system, workspaceFor: () => project }
    const pluginFile = join('.openclaw', 'extensions', 'pushary', 'index.js')
    assert.equal(asks(write(join(project, pluginFile)), outside), true)
    assert.equal(asks(write(pluginFile), outside), true)
  })

  it('gates the workspace hooks folder when the workspace sits outside the state directory', () => {
    const outside = { ...system, workspaceFor: () => project }
    assert.equal(asks(write(join(project, 'hooks', 'x', 'handler.js')), outside), true)
    assert.equal(asks(write(join(project, 'src', 'app.ts')), outside), false)
  })

  it('gates a relative path that climbs out of the workspace into the state directory', () => {
    assert.equal(asks(write('../openclaw.json')), true)
    assert.equal(asks(edit('./notes/../../hooks/x/handler.js')), true)
    assert.equal(asks(write('@../openclaw.json')), true)
  })

  it('gates a path that reaches the state directory through a symlink', () => {
    symlinkSync(state, join(project, 'claw'))
    assert.equal(asks(write(join(project, 'claw', 'hooks', 'x', 'handler.js'))), true)
  })

  it('asks for a write through a symbolic link whose target does not exist yet, which the write would create', () => {
    mkdirSync(join(workspace, 'docs'))
    symlinkSync(join('..', 'hooks', 'evil.js'), join(workspace, 'docs', 'notes.md'))
    symlinkSync(join('..', '..', 'not-yet'), join(workspace, 'later'))
    const link = join(workspace, 'docs', 'notes.md')
    for (const path of ['docs/notes.md', link, '~/.openclaw/workspace/docs/notes.md', 'later/openclaw.json', `${link}/`, `${link}//`, `@${link}/`, '~/.openclaw/workspace/docs/notes.md/', 'docs/notes.md/']) {
      assert.equal(asks(write(path)), true, path)
    }
    assert.equal(asks(patch(['*** Begin Patch', `*** Add File: ${link}/`, '+x', '*** End Patch'].join('\n'))), true)
    assert.equal(asks(patch(['*** Begin Patch', '*** Update File: src.md', `*** Move to: ${link}/`, '*** End Patch'].join('\n'))), true)
    assert.equal(asks(patch(['*** Begin Patch', '*** Delete File: x.md', '*** End Patch'].join('\n'), [`${link}/`])), true)
    assert.equal(asks(write('docs/new.md')), false)
    assert.equal(asks(write(`${join(workspace, 'docs')}/`)), false)
    assert.equal(asks(write(join(workspace, 'fresh', 'deeper', 'new.md'))), false)
  })

  it('asks when it cannot tell whether a missing part of the path is a symbolic link', () => {
    assert.equal(asks(write('docs/new.md'), { ...system, mayBeSymbolicLink: () => true }), true)
  })

  it('gates a differently cased spelling on a case-insensitive disk', () => {
    assert.equal(asks(write(join(state, 'OpenClaw.JSON')), { ...system, caseInsensitive: true }), true)
  })

  it('gates a spelling a case-insensitive disk folds to a protected name, such as a long s or a ligature', () => {
    const caseInsensitive = { ...system, caseInsensitive: true }
    for (const path of ['hook\u017f/x.js', 'HOOK\u017f/x.js', join(state, 'openclaw.j\u017fon'), '~/Library/LaunchAgents/ai.openclaw.gateway.pli\ufb06', '.openclaw/extensions/p/index.js'.replace('extensions', 'exten\u017fions')]) {
      assert.equal(asks(write(path), caseInsensitive), true, JSON.stringify(path))
      assert.equal(asks(edit(path), caseInsensitive), true, JSON.stringify(path))
    }
    assert.equal(asks(write('src/\u017fample.ts'), caseInsensitive), false)
    assert.equal(asks(write('hoo\u212as/x.js'), caseInsensitive), true)
  })

  it('folds only what a case-insensitive disk folds, so a look-alike dot or letter does not hide a protected place', () => {
    const caseInsensitive = { ...system, caseInsensitive: true }
    for (const path of [
      'hooks/\u2025/x.txt', './hooks/\u2025/x.txt', 'hooks/\uff0e\uff0e/x.txt', join(workspace, 'hooks', '\u2025', 'x.txt'), '~/.openclaw/workspace/hooks/\u2025/x.txt', join(workspace, '.openclaw', '\u2025', 'x.txt'),
      '../\uff57orkspace/notes.md', '~/.openclaw/\uff57orkspace/notes.md', join(state, '\uff57orkspace', 'notes.md'), '~/.openclaw/workspace\uff0fx', '~/.openclaw/\u02b7orkspace/notes.md', '~/.openclaw/workspac\u2091/notes.md',
    ]) {
      assert.equal(asks(write(path), caseInsensitive), true, JSON.stringify(path))
      assert.equal(asks(edit(path), caseInsensitive), true, JSON.stringify(path))
    }
    assert.equal(spawn({ cwd: '~/.openclaw/\uff57orkspace' }, caseInsensitive), true)
    for (const path of ['../WORK\u017fPACE/notes.md', '~/.openclaw/WORKSPACE/notes.md', 'docs/stra\u00dfe.md', 'docs/caf\u00e9.md', 'docs/cafe\u0301.md']) {
      assert.equal(asks(write(path), caseInsensitive), false, JSON.stringify(path))
    }
  })

  it('folds letters onto the non-ASCII letters a case-insensitive disk folds them onto, so a respelled folder name still reaches the protected place, judged by the path as Node resolves it', () => {
    const cyrillic = join(home, 'Проекты')
    assert.equal(asks(write('~/Прᲂекты/hooks/x.js'), { ...system, caseInsensitive: true, workspaceFor: () => cyrillic }), true)
    const micro = join(home, 'lab-μ')
    assert.equal(asks(write('~/lab-µ/hooks/x.js'), { ...system, caseInsensitive: true, workspaceFor: () => micro }), true)
    const greekState = join(home, 'Ρυθμίσεις')
    const greekLocations = { ...locations, stateDirectories: [greekState], configFiles: [join(greekState, 'openclaw.json')] }
    const spelledWithSigma = '~/Ρυθμίσεισ/openclaw.json'
    assert.equal(asks(write(spelledWithSigma), { ...system, caseInsensitive: true }, greekLocations), true)
    assert.equal(asks(edit(spelledWithSigma), { ...system, caseInsensitive: true }, greekLocations), true)
  })

  it('folds a subscript iota where it stands, as a case-insensitive disk does, whatever marks sit around it', () => {
    const taiwan = join(state, 'Ταϊβάν')
    assert.equal(asks(write('~/.openclaw/Τᾳ̈βάν/notes.md'), { ...system, caseInsensitive: true, workspaceFor: () => taiwan }), true)
    const songState = join(home, 'ᾷσμα')
    const songLocations = { ...locations, stateDirectories: [songState], configFiles: [join(songState, 'openclaw.json')] }
    for (const event of [write('~/ᾼ͂σμα/openclaw.json'), edit('~/ᾼ͂σμα/openclaw.json')]) {
      assert.equal(asks(event, { ...system, caseInsensitive: true }, songLocations), true)
    }
    const song = join(home, 'ᾷσμα')
    assert.equal(asks(write('~/ᾼ͂σμα/hooks/x.js'), { ...system, caseInsensitive: true, workspaceFor: () => song }), true)
  })

  it('asks when a name has a character the runtime cannot fold the way a case-insensitive disk does', () => {
    const caseInsensitive = { ...system, caseInsensitive: true }
    const iotas = join(state, `ws-${'ι'.repeat(9)}`)
    assert.equal(asks(write(`~/.openclaw/ws-${'ͅ'.repeat(9)}/notes.md`), { ...caseInsensitive, workspaceFor: () => iotas }), true)
    assert.equal(spawn({ cwd: `~/.openclaw/ws-${'ͅ'.repeat(9)}` }, { ...caseInsensitive, workspaceFor: () => iotas }), true)
    const subscripts = join(state, `ws-${'ͅ'.repeat(9)}`)
    assert.equal(asks(write(`~/.openclaw/ws-${'ι'.repeat(9)}/notes.md`), { ...caseInsensitive, workspaceFor: () => subscripts }), true)
    const thorn = join(home, 'proj-꟒')
    assert.equal(asks(write('~/proj-ꟓ/hooks/x.js'), { ...caseInsensitive, workspaceFor: () => thorn }), true)
    assert.equal(asks(write('~/proj-͸/notes.md'), caseInsensitive), true)
    const replacement = join(home, 'proj-�')
    assert.equal(asks(write('~/proj-\ud800/hooks/x.js'), { ...caseInsensitive, workspaceFor: () => replacement }), true)
    const ode = join(state, 'ᾠδῇ')
    assert.equal(asks(write('~/.openclaw/ᾨΔῌ͂/notes.md'), { ...caseInsensitive, workspaceFor: () => ode }), false)
    assert.equal(asks(write(`~/.openclaw/ws-${'ͅ'.repeat(9)}/notes.md`), { ...system, workspaceFor: () => iotas }), true)
    assert.equal(asks(write('src/ᾳ.ts')), false)
  })

  it('lets a differently cased spelling of a non-ASCII workspace through, final sigma included', () => {
    const greek = join(state, 'Φάκελος')
    const caseInsensitive = { ...system, caseInsensitive: true, workspaceFor: () => greek }
    assert.equal(asks(write('~/.openclaw/ΦΆΚΕΛΟΣ/notes.md'), caseInsensitive), false)
    assert.equal(spawn({ cwd: '~/.openclaw/ΦΆΚΕΛΟΣ' }, caseInsensitive), false)
  })

  it('keeps a dotless i apart from i, as a case-insensitive disk does', () => {
    const writer = join(state, 'workspace-writer')
    mkdirSync(writer)
    const caseInsensitive = { ...system, caseInsensitive: true, workspaceFor: () => writer }
    assert.equal(asks(write('../workspace-wr\u0131ter/notes.md'), caseInsensitive), true)
    assert.equal(asks(write('../WORKSPACE-WRITER/notes.md'), caseInsensitive), false)
  })

  it('gates an apply_patch when one of its files is protected', () => {
    const text = ['*** Begin Patch', '*** Update File: src/app.ts', '@@', '-a', '+b', '*** Add File: ../hooks/x/handler.js', '+x', '*** End Patch'].join('\n')
    assert.deepEqual(patchTargetsOf(text), ['src/app.ts', '../hooks/x/handler.js'])
    assert.equal(asks(patch(text)), true)
    const moved = ['*** Begin Patch', '*** Update File: src/app.ts', '*** Move to: ~/.openclaw/conf/main.json5', '*** End Patch'].join('\n')
    assert.equal(asks(patch(moved)), true)
  })

  it('gates an apply_patch whose host-resolved paths reach the state directory', () => {
    const text = ['*** Begin Patch', '*** Delete File: config', '*** End Patch'].join('\n')
    assert.equal(asks(patch(text, [join(state, 'openclaw.json')])), true)
  })
})

describe('a relative path from a session started deeper in the workspace', () => {
  it('gates a climb that would reach the state directory from any folder inside the workspace', () => {
    assert.equal(asks(write('../../../openclaw.json')), true)
    assert.equal(asks(edit('../../extensions/pushary/dist/index.js')), true)
  })

  it('lets a climb that stays out of protected places through', () => {
    const outside = { ...system, workspaceFor: () => join(project, 'src') }
    assert.equal(asks(write('../README.md'), outside), false)
  })
})

describe('the gateway working folder .env', () => {
  it('gates a write to the .env OpenClaw loads from the gateway working folder', () => {
    const withGatewayEnv = { ...locations, configFiles: [...locations.configFiles, join(project, '.env')] }
    assert.equal(asks(write(join(project, '.env')), system, withGatewayEnv), true)
    assert.equal(asks(write(join(project, 'src', '.env')), system, withGatewayEnv), false)
  })

  it('gates it when the path carries an </arg_value>> tail that OpenClaw strips before writing', () => {
    const withGatewayEnv = { ...locations, configFiles: [...locations.configFiles, join(project, '.env')] }
    for (const path of [`${join(project, '.env')}</arg_value>>`, `${join(project, '.env')}</arg_value>> </arg_value>>`, `${join(project, '.env')}</arg_value>>/`, `${join(project, '.env')}</arg_value>>/x/..`]) {
      assert.equal(asks(write(path), system, withGatewayEnv), true, path)
    }
    const moved = { ...locations, configFiles: [join(root, 'etc', 'claw.json')] }
    assert.equal(asks(edit(`${join(root, 'etc', 'claw.json')}</arg_value>>`), system, moved), true)
  })

  it('gates it when OpenClaw strips the tail again after resolving the path, as workspace-only setups do', () => {
    const gatewayEnv = join(project, '.env')
    const config = join(root, 'etc', 'claw.json')
    const protectedFiles = { ...locations, configFiles: [...locations.configFiles, gatewayEnv, config] }
    for (const path of [
      `${gatewayEnv}</arg_value>>/</arg_value>>`,
      `${join(project, 'src')}/../.env</arg_value>>/</arg_value>>`,
      `file://${gatewayEnv}%3C/arg_value%3E%3E`,
      `FILE://${gatewayEnv}%3c/arg_value%3e%3e`,
      `file://${gatewayEnv}</arg_value>>?q`,
      `file://${gatewayEnv}</arg_value>>#h`,
      `@file://${gatewayEnv}</arg_value>>?`,
      `${config}</arg_value>>/</arg_value>>`,
      `file://${config}%3C/arg_value%3E%3E`,
    ]) {
      assert.equal(asks(write(path), system, protectedFiles), true, path)
    }
  })
})

const spawn = (params: Readonly<Record<string, unknown>>, guard: WriteGuardSystem = system): boolean =>
  spawnsOutsideTheWorkspace(locations, guard, { toolId: 'sessions_spawn', event: { toolName: 'sessions_spawn', params: { task: 'fix it', ...params } }, agentId: undefined })

describe('a session spawned into another folder', () => {
  it('runs without asking when it names no folder, or a folder inside the agent workspace', () => {
    assert.equal(spawn({}), false)
    assert.equal(spawn({ cwd: workspace }), false)
    assert.equal(spawn({ cwd: join(workspace, 'sub') }), false)
    assert.equal(spawn({ cwd: 'sub' }), false)
  })

  it('asks when the folder is the state directory or anywhere else outside the workspace', () => {
    assert.equal(spawn({ cwd: state }), true)
    assert.equal(spawn({ cwd: '~/.openclaw' }), true)
    assert.equal(spawn({ cwd: '..' }), true)
    assert.equal(spawn({ cwd: project }), true)
  })

  it('asks when the folder is the workspace hooks folder, where a relative write would land in code OpenClaw loads', () => {
    assert.equal(spawn({ cwd: join(workspace, 'hooks') }), true)
    assert.equal(spawn({ cwd: join(workspace, 'hooks', 'x') }), true)
    assert.equal(spawn({ cwd: 'hooks' }), true)
  })

  it('asks when the folder is the workspace .openclaw folder', () => {
    assert.equal(spawn({ cwd: join(workspace, '.openclaw') }), true)
    assert.equal(spawn({ cwd: join(workspace, '.openclaw', 'extensions') }), true)
  })

  it('asks for every ACP session, whose harness runs its own tools outside before_tool_call', () => {
    assert.equal(spawn({ runtime: 'acp', agentId: 'codex', task: 'fix the tests' }), true)
    assert.equal(spawn({ runtime: ' ACP ', cwd: workspace }), true)
    assert.equal(spawn({ runtime: 'subagent', task: 'fix the tests' }), false)
  })

  it('asks when the folder is not text, is empty, or comes from a project or managed worktree it cannot see', () => {
    for (const params of [{ cwd: 42 }, { cwd: '  ' }, { projectId: 'app' }, { projectGitUrl: 'https://github.com/acme/app' }, { worktree: true }]) {
      assert.equal(spawn(params), true, JSON.stringify(params))
    }
  })

  it('asks for any folder when the workspace is unknown', () => {
    assert.equal(spawn({ cwd: join(workspace, 'sub') }, { ...system, workspaceFor: () => null }), true)
  })

  it('never looks at other tools', () => {
    assert.equal(spawnsOutsideTheWorkspace(locations, system, { toolId: 'write', event: { toolName: 'write', params: { cwd: state } }, agentId: undefined }), false)
  })
})

describe('paths it cannot resolve with certainty ask', () => {
  for (const [name, path] of [['a missing path', undefined], ['an empty path', '  '], ['a path that is not text', 42], ['a file URL for another host', 'file://remote/etc/x']] as const) {
    it(`gates ${name}`, () => assert.equal(asks(write(path)), true))
  }

  it('gates an apply_patch with no file in it', () => {
    assert.equal(asks(patch('rm -rf ~/.openclaw')), true)
    assert.equal(asks({ toolName: 'apply_patch', params: {} }), true)
  })

  it('gates a relative path, and any write into the state directory, when the workspace is unknown', () => {
    const unknown = { ...system, workspaceFor: () => null }
    assert.equal(asks(write('src/app.ts'), unknown), true)
    assert.equal(asks(write(join(workspace, 'notes.md')), unknown), true)
    assert.equal(asks(write(join(project, 'src', 'app.ts')), unknown), false)
  })

  it('gates a relative path that names the state directory, wherever the run started', () => {
    assert.equal(asks(write('.openclaw/hooks/x/handler.js')), true)
    assert.equal(asks(write('openclaw.json')), true)
  })

  it('gates a path whose real location it cannot read', () => {
    const failing: WriteGuardSystem = { ...system, realpath: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
    assert.equal(asks(write(join(project, 'src', 'app.ts')), failing), true)
  })
})

describe('ordinary coding runs without asking', () => {
  it('lets a home path that climbs back out through, wherever the gateway started', () => {
    for (const guard of [system, { ...system, otherWorkingDirectories: [state] }, { ...system, workspaceFor: () => null }]) {
      assert.equal(asks(write(`~/../project/src/a.ts`), guard), false)
      assert.equal(asks(write(join(project, 'src', 'a.ts')), guard), false)
    }
  })

  it('lets writes and edits in the workspace under the state directory, or in a project, through', () => {
    assert.equal(asks(write('src/app.ts')), false)
    assert.equal(asks(edit(join(workspace, 'notes.md'))), false)
    assert.equal(asks(write(join(project, 'src', 'app.ts'))), false)
    assert.equal(asks(write(join(realpathSync(project), 'src', 'new', 'file.ts'))), false)
  })

  it('lets an apply_patch that only touches workspace files through', () => {
    const text = ['*** Begin Patch', '*** Update File: src/app.ts', '@@', '-a', '+b', '*** Add File: src/new.ts', '+x', '*** End Patch'].join('\n')
    assert.equal(asks(patch(text, [join(workspace, 'src', 'app.ts'), join(workspace, 'src', 'new.ts')])), false)
  })

  it('never exempts a workspace that is the state directory itself', () => {
    assert.equal(asks(write(join(state, 'openclaw.json')), { ...system, workspaceFor: () => state }), true)
  })

  it('never looks at tools that do not write files', () => {
    assert.equal(asks({ toolName: 'read', params: { path: join(state, 'openclaw.json') } }), false)
  })
})
