#!/usr/bin/env ts-node

/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2017 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
// tslint:disable:no-shadowed-variable
import * as test  from 'blue-tape'
// import * as sinon from 'sinon'

import {
  config,
  Contact,
  FriendRequest,
  IoClient,
  Message,
  Puppet,
  PuppetWeb,
  Room,
  Wechaty,

  log,
  VERSION,
}               from '../'

test('Wechaty Framework', async t => {
  t.ok(Contact      , 'should export Contact')
  t.ok(FriendRequest, 'should export FriendREquest')
  t.ok(IoClient     , 'should export IoClient')
  t.ok(Message      , 'should export Message')
  t.ok(Puppet       , 'should export Puppet')
  t.ok(PuppetWeb    , 'should export PuppetWeb')
  t.ok(Room         , 'should export Room')
  t.ok(Wechaty      , 'should export Wechaty')
  t.ok(log          , 'should export log')

  const bot = Wechaty.instance()
  t.is(bot.version(true), require('../package.json').version,
                          'should return version as the same in package.json',
  )
  t.is(VERSION, require('../package.json').version,
                  'should export version in package.json',
  )
})

test('Wechaty Config setting', async t => {
  t.ok(config                 , 'should export Config')
  t.ok(config.DEFAULT_PUPPET  , 'should has DEFAULT_PUPPET')
})
