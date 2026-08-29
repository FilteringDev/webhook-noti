import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgetConfirmation } from '../../../apps/notifier/source/forget.js'

test('consumes confirmation only for its requesting user and source', () => {
  const Confirmations = new ForgetConfirmation()
  const Id = Confirmations.Create('user-a', 'guild-a', { Platform: 'discord', Type: 'guild', GuildId: 'guild-a' })

  assert.equal(Confirmations.Take(Id, 'user-b', 'guild-a'), null)
  assert.equal(Confirmations.Take(Id, 'user-a', 'guild-b'), null)
  assert.deepEqual(Confirmations.Take(Id, 'user-a', 'guild-a'), { Platform: 'discord', Type: 'guild', GuildId: 'guild-a' })
  assert.equal(Confirmations.Take(Id, 'user-a', 'guild-a'), null)
})