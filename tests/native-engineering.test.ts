import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const script = path.resolve('templates/skills/native-engineering/scripts/native-engineering.mjs')

describe('native engineering runner', () => {
  let root: string
  let external: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-engineering-'))
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-engineering-outside-'))
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  })

  function writeConfig(options: {
    profiles?: Record<string, unknown>
    tools?: unknown[]
    workingDirectory?: string
  } = {}) {
    const profile = {
      ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
      commands: {
        prepare: [{ name: 'prepare', command: [process.execPath, '-e', ''] }],
        build: [{ name: 'build', command: [process.execPath, '-e', ''] }],
        verify: [{ name: 'verify', command: [process.execPath, '-e', ''] }],
        'deps-update': [{ name: 'update', command: [process.execPath, '-e', ''] }],
      },
      ...(options.profiles?.default as object | undefined),
    }
    const config = {
      schemaVersion: 1,
      tools: options.tools ?? [],
      profiles: options.profiles ?? { default: profile },
    }
    fs.writeFileSync(path.join(root, '.harness/native.json'), JSON.stringify(config))
    return config
  }

  function invoke(...args: string[]) {
    return spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8', timeout: 10000 })
  }

  function result(...args: string[]) {
    const response = invoke(...args)
    return { ...response, json: JSON.parse(response.stdout) }
  }

  it('should discover root and nested candidates including paths with spaces', () => {
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), '')
    const nested = path.join(root, 'native sources', 'module')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'conanfile.py'), '')

    const response = result('discover')

    expect(response.status).toBe(0)
    expect(response.json.candidates).toEqual(['.', path.join('native sources', 'module')])
  })

  it('should block ambiguous discovery and let explicit workdir override the profile', () => {
    for (const directory of ['one', 'two', 'explicit']) {
      const target = path.join(root, directory)
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'CMakeLists.txt'), '')
    }
    writeConfig()

    const blocked = result('build')
    const explicit = result('build', '--workdir', 'explicit')

    expect(blocked.json.status).toBe('BLOCKED')
    expect(explicit.json.workingDirectory).toBe(fs.realpathSync(path.join(root, 'explicit')))
  })

  it('should reject lexical traversal and symlink directory escape', () => {
    fs.mkdirSync(path.join(root, 'inside'))
    fs.mkdirSync(path.join(external, 'outside'))
    fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    writeConfig()

    expect(invoke('build', '--workdir', '..').status).toBe(2)
    expect(invoke('build', '--workdir', 'linked/outside').status).toBe(2)
  })

  it('should distinguish a missing tool and reject a version outside its configured range', () => {
    writeConfig({ workingDirectory: '.', tools: [{ name: 'missing', command: ['native-engineering-command-that-does-not-exist'] }] })
    const missing = result('doctor')
    writeConfig({ workingDirectory: '.', tools: [{ name: 'node', command: [process.execPath, '-e', 'console.log("v1.2.3")'], minVersion: '2.0.0' }] })
    const version = result('doctor')

    expect(missing.json.steps[0].error).toContain('Not available on current PATH')
    expect(version.json.steps[0]).toMatchObject({ status: 'BLOCKED', version: '1.2.3' })
  })

  it.runIf(process.platform === 'win32')('should resolve extensionless absolute and relative tool paths on Windows', () => {
    const executable = process.execPath.replace(/\.exe$/i, '')
    for (const command of [executable, path.relative(root, executable)]) {
      writeConfig({ workingDirectory: '.', tools: [{ name: 'Node', command: [command, '--version'] }] })

      const response = result('doctor')

      expect(response.status).toBe(0)
      expect(response.json.steps[0].status).toBe('PASS')
      expect(response.json.steps[0].path.toLowerCase()).toBe(process.execPath.toLowerCase())
    }
  })

  it('should flush a complete large PLAN to a slow pipe before exiting', async () => {
    const argument = 'x'.repeat(256 * 1024)
    writeConfig({ profiles: { default: { workingDirectory: '.', commands: {
      build: [{ name: 'large plan', command: [process.execPath, '-e', '', argument] }],
    } } } })

    const child = spawn(process.execPath, [script, 'build', '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000,
    })
    const response = await new Promise<{ exitCode: number | null, stdout: string, stderr: string }>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.stdout.pause()
      const resume = setTimeout(() => child.stdout.resume(), 200)
      child.once('error', error => { clearTimeout(resume); reject(error) })
      child.once('close', exitCode => { clearTimeout(resume); resolve({ exitCode, stdout, stderr }) })
    })

    expect(response.exitCode, response.stderr).toBe(0)
    const report = JSON.parse(response.stdout)
    expect(report.status).toBe('PLAN')
    expect(report.steps[0].command[3]).toBe(argument)
  })

  it('should keep PLAN side-effect free and stop ordered commands after failure or timeout', () => {
    const marker = path.join(root, 'ran.txt')
    writeConfig({ profiles: { default: {
      workingDirectory: '.',
      commands: { build: [
        { name: 'first', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] },
        { name: 'fail', command: [process.execPath, '-e', 'process.exit(7)'] },
        { name: 'never', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] },
      ] },
    } } })

    const plan = result('build')
    expect(plan.json.status).toBe('PLAN')
    expect(fs.existsSync(marker)).toBe(false)
    const failed = result('build', '--execute')
    expect(failed.json.status).toBe('FAIL')
    expect(failed.json.steps.map((step: { name: string }) => step.name)).toEqual(['first', 'fail'])
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran')

    writeConfig({ profiles: { default: { workingDirectory: '.', commands: { verify: [
      { name: 'slow', command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'], timeoutMs: 30 },
      { name: 'never', command: [process.execPath, '-e', ''] },
    ] } } } })
    const timeout = result('verify', '--execute')
    expect(timeout.json.steps).toHaveLength(1)
    expect(timeout.json.steps[0].error).toContain('timed out')
  })

  it('should protect conan.lock during normal builds and leave changed content for review', () => {
    const lock = path.join(root, 'conan.lock')
    fs.writeFileSync(lock, 'before')
    writeConfig({ profiles: { default: { workingDirectory: '.', commands: { build: [{ name: 'change lock', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(lock)}, 'after')`] }] } } } })

    const response = result('build', '--execute')

    expect(response.json.status).toBe('FAIL')
    expect(response.json.steps.at(-1).error).toContain('conan.lock')
    expect(fs.readFileSync(lock, 'utf8')).toBe('after')
  })

  it('should plan dependency updates by default and execute them only explicitly', () => {
    const marker = path.join(root, 'updated.txt')
    writeConfig({ profiles: { default: { workingDirectory: '.', commands: { 'deps-update': [{ name: 'update', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'updated')`] }] } } } })

    expect(result('deps-update').json.status).toBe('PLAN')
    expect(fs.existsSync(marker)).toBe(false)
    expect(result('deps-update', '--execute').json.status).toBe('PASS')
    expect(fs.readFileSync(marker, 'utf8')).toBe('updated')
  })

  it('should return configuration errors and block empty actions instead of reporting PASS', () => {
    fs.writeFileSync(path.join(root, '.harness/native.json'), '{invalid')
    expect(invoke('doctor').status).toBe(2)
    writeConfig({ profiles: { default: { commands: { verify: [] } } } })
    expect(result('verify').json.status).toBe('BLOCKED')
  })

  it('should keep the distributed skill mirror byte-identical', () => {
    const source = path.resolve('templates/skills/native-engineering')
    const mirror = path.resolve('.harness/skills/native-engineering')
    const files = (directory: string, base = directory): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name)
      return entry.isDirectory() ? files(filename, base) : [path.relative(base, filename)]
    }).sort()
    const collect = (directory: string, base = directory): Map<string, string> => new Map(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name)
      return entry.isDirectory() ? [...collect(filename, base)] : [[path.relative(base, filename), fs.readFileSync(filename, 'utf8')] as [string, string]]
    }))
    expect(files(source)).toEqual(files(mirror))
    expect(collect(source)).toEqual(collect(mirror))
  })

  it('should use the selected directory and profile environment for probes and execution', () => {
    const directory = path.join(root, 'native sources')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'conanfile.py'), '')
    const nodeName = path.basename(process.execPath)
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    writeConfig({
      tools: [{ name: 'Node', command: [nodeName, '-e',
        'if (!process.env.NATIVE_TEST || !process.cwd().endsWith("native sources")) process.exit(9); console.log("tool 2.1.0"); process.exit(2)'],
      minVersion: '2.0.0', maxVersionExclusive: '3.0.0', acceptedExitCodes: [0, 2] }],
      profiles: { default: {
        environment: { [pathKey]: path.dirname(process.execPath), NATIVE_TEST: 'private-value' },
        commands: { build: [{ name: 'check directory', command: [nodeName, '-e',
          'require("node:fs").writeFileSync("observed.txt", process.env.NATIVE_TEST)'] }] },
      } },
    })

    const response = result('build', '--execute')

    expect(response.status).toBe(0)
    expect(response.json.workingDirectory).toBe(fs.realpathSync(directory))
    expect(response.json.tools[0]).toMatchObject({ status: 'PASS', version: '2.1.0', exitCode: 2 })
    expect(fs.readFileSync(path.join(directory, 'observed.txt'), 'utf8')).toBe('private-value')
    expect(response.stdout).not.toContain('private-value')
  })

  it('should reject lock output flags inside normal configured commands before execution', () => {
    for (const action of ['prepare', 'build', 'verify']) {
      for (const flag of ['--lockfile-out', '--lockfile-out=conan.lock']) {
        writeConfig({ profiles: { default: { workingDirectory: '.', commands: {
          [action]: [{ name: 'unsafe lock output', command: [process.execPath, flag] }],
        } } } })
        const response = invoke(action)
        expect(response.status).toBe(2)
        expect(response.stderr).toContain('only in the deps-update action')
      }
    }
  })

  it('should require configured protected files but allow an explicit dependency bootstrap', () => {
    writeConfig({ profiles: { default: { workingDirectory: '.', protectedFiles: ['conan.lock'], commands: {
      build: [{ name: 'build', command: [process.execPath, '-e', ''] }],
      'deps-update': [{ name: 'create lock', command: [process.execPath, '-e',
        'require("node:fs").writeFileSync("conan.lock", "initial")'] }],
    } } } })

    expect(result('doctor').json.status).toBe('BLOCKED')
    expect(result('build', '--execute').json.error).toContain('Missing protected files')
    expect(result('deps-update').json.status).toBe('PLAN')
    expect(fs.existsSync(path.join(root, 'conan.lock'))).toBe(false)
    expect(result('deps-update', '--execute').json.status).toBe('PASS')
    expect(result('build', '--execute').json.status).toBe('PASS')
  })

  it('should detect protected-file changes even when a command fails and when a lock is newly created', () => {
    writeConfig({ profiles: { default: { workingDirectory: '.', commands: { build: [
      { name: 'new lock and fail', command: [process.execPath, '-e',
        'require("node:fs").writeFileSync("conan.lock", "unexpected"); process.exit(7)'] },
      { name: 'never', command: [process.execPath, '-e', 'process.exit(9)'] },
    ] } } } })

    const response = result('build', '--execute')

    expect(response.json.status).toBe('FAIL')
    expect(response.json.steps).toHaveLength(2)
    expect(response.json.steps[0].exitCode).toBe(7)
    expect(response.json.steps[1].error).toContain('conan.lock')
  })

  it('should reject malformed action shapes and require explicit selection among profiles', () => {
    writeConfig({ profiles: { first: { workingDirectory: '.' }, second: { workingDirectory: '.' } } })
    expect(result('doctor').json.status).toBe('BLOCKED')
    expect(result('doctor', '--profile', 'first').json.status).toBe('PASS')
    expect(invoke('doctor', '--profile', 'missing').status).toBe(2)
    for (const commands of [[], null, 'build']) {
      writeConfig({ profiles: { default: { workingDirectory: '.', commands } } })
      expect(invoke('doctor').status).toBe(2)
    }
  })

  it('should redact configured environment values from failed-command summaries', () => {
    writeConfig({ profiles: { default: { workingDirectory: '.', environment: { NATIVE_SECRET: 'private-marker-123' },
      commands: { verify: [{ name: 'fail', command: [process.execPath, '-e',
        'console.error(process.env.NATIVE_SECRET); process.exit(4)'] }] },
    } } })
    const response = result('verify', '--execute')
    expect(response.json.status).toBe('FAIL')
    expect(response.stdout).not.toContain('private-marker-123')
    expect(response.json.steps[0].error).toContain('[redacted]')
  })

  it.runIf(process.platform === 'win32')('should bound timeout cleanup when Windows taskkill is unavailable', () => {
    const pidFile = path.join(root, 'descendant.pid')
    const child = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
      'setTimeout(()=>{},15000);',
    ].join('')
    writeConfig({ profiles: { default: { workingDirectory: '.', environment: {
      SystemRoot: process.env['SystemRoot'] || 'C:\\Windows',
    }, commands: { verify: [
      { name: 'slow process', command: [process.execPath, '-e', child], timeoutMs: 300 },
    ] } } } })
    try {
      const launcher = [
        `process.env.SystemRoot=${JSON.stringify(external)};`,
        `process.argv=[process.execPath,${JSON.stringify(script)},"verify","--execute","--root",${JSON.stringify(root)}];`,
        `import(require("node:url").pathToFileURL(${JSON.stringify(script)}).href);`,
      ].join('')
      const response = spawnSync(process.execPath, ['-e', launcher], {
        encoding: 'utf8', timeout: 10000,
      })
      expect(response.stdout.trim(), response.stderr).not.toBe('')
      const report = JSON.parse(response.stdout)
      expect(response.status).toBe(1)
      expect(report.status).toBe('FAIL')
      expect(report.steps[0].error).toContain('termination could not be confirmed')
      expect(report.steps[0].durationMs).toBeLessThan(8000)
    } finally {
      if (fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))) } catch {}
      }
    }
  })
})
