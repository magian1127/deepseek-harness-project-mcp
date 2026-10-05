import test from 'node:test'
import assert from 'node:assert/strict'
import { profileNameFrom, profileDir } from '../profile-modules.js'

test('profileNameFrom 读取 --profile 标志', () => {
  assert.equal(profileNameFrom(['node', 'dsh', '--profile', 'web'], undefined), 'web')
})

test('profileNameFrom 在 Electron 下默认 desktop', () => {
  assert.equal(profileNameFrom(['node', 'app'], '38.0.0'), 'desktop')
})

test('profileNameFrom 无标志非 Electron 时默认 web', () => {
  assert.equal(profileNameFrom(['node', 'dsh'], undefined), 'web')
})

test('profileNameFrom 忽略以 - 开头的伪值', () => {
  assert.equal(profileNameFrom(['node', 'dsh', '--profile', '--help'], undefined), 'web')
})

test('profileDir 落在 DSH_HOME/profiles/<name>', () => {
  const original = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-test-home'
  try {
    assert.equal(profileDir(), '/tmp/dsh-test-home/profiles/web')
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})
