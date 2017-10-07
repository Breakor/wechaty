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
import { EventEmitter } from 'events'

import { StateSwitch }  from 'state-switch'

import {
  Sayable,
  log,
}                       from './config'
import Contact          from './contact'
import FriendRequest    from './friend-request'
import {
  Message,
  MediaMessage,
  // MsgRawObj,
}                       from './message'
import Profile          from './profile'
import Room             from './room'
import {
  WatchratFood,
}                       from './watchrat'
import {
  WechatyEvent,
}                       from './wechaty'

export interface ScanInfo {
  url:  string,
  code: number,
}

export type PuppetEvent = WechatyEvent
                              | 'ding'
                              | 'watchdog'

export interface PuppetOptions {
  profile: Profile,
}
/**
 * Abstract Puppet Class
 */
export abstract class Puppet extends EventEmitter implements Sayable {
  public userId:  string  | null
  public user:    Contact | null
  public abstract getContact(id: string): Promise<any>

  public state = new StateSwitch<'live', 'dead'>('Puppet', 'dead', log)

  constructor(public options: PuppetOptions) {
    super()
  }

  public emit(event: 'ding',        text: string)                                                  : boolean
  public emit(event: 'error',       e: Error)                                                      : boolean
  public emit(event: 'friend',      friend: Contact, request?: FriendRequest)                      : boolean
  public emit(event: 'heartbeat',   data: any)                                                     : boolean
  public emit(event: 'login',       user: Contact)                                                 : boolean
  public emit(event: 'logout',      user: Contact | string)                                        : boolean
  public emit(event: 'message',     message: Message)                                              : boolean
  public emit(event: 'room-join',   room: Room, inviteeList: Contact[],  inviter: Contact)         : boolean
  public emit(event: 'room-leave',  room: Room, leaverList: Contact[])                             : boolean
  public emit(event: 'room-topic',  room: Room, topic: string, oldTopic: string, changer: Contact) : boolean
  public emit(event: 'scan',        url: string, code: number)                                     : boolean
  public emit(event: 'watchdog',    food: WatchratFood)                                            : boolean
  public emit(event: never, ...args: any[])                                                        : boolean

  public emit(
    event:   PuppetEvent,
    ...args: any[],
  ): boolean {
    return super.emit(event, ...args)
  }

  public on(event: 'ding',        listener: (text: string) => void)                                                  : this
  public on(event: 'error',       listener: (e: Error) => void)                                                      : this
  public on(event: 'friend',      listener: (friend: Contact, request?: FriendRequest) => void)                      : this
  public on(event: 'heartbeat',   listener: (data: any) => void)                                                     : this
  public on(event: 'login',       listener: (user: Contact) => void)                                                 : this
  public on(event: 'logout',      listener: (user: Contact) => void)                                                 : this
  public on(event: 'message',     listener: (message: Message) => void)                                              : this
  public on(event: 'room-join',   listener: (room: Room, inviteeList: Contact[],  inviter: Contact) => void)         : this
  public on(event: 'room-leave',  listener: (room: Room, leaverList: Contact[]) => void)                             : this
  public on(event: 'room-topic',  listener: (room: Room, topic: string, oldTopic: string, changer: Contact) => void) : this
  public on(event: 'scan',        listener: (info: ScanInfo) => void)                                                : this
  public on(event: 'watchdog',    listener: (data: WatchratFood) => void)                                            : this
  public on(event: never, listener: any)                                                                             : this

  public on(
    event:    PuppetEvent,
    listener: ((...args: any[]) => void),
  ): this {
    super.on(event, listener)
    return this
  }

  public abstract async init() : Promise<void>

  public abstract self() : Contact

  public abstract send(message: Message | MediaMessage)              : Promise<boolean>
  public abstract forward(message: Message, contact: Contact | Room) : Promise<boolean>
  public abstract say(content: string)                               : Promise<boolean>

  public abstract reset(reason?: string) : void
  public abstract logout()               : Promise<void>
  public abstract quit()                 : Promise<void>

  public abstract ding() : Promise<string>

  /**
   * FriendRequest
   */
  public abstract friendRequestSend(contact: Contact, hello?: string)   : Promise<any>
  public abstract friendRequestAccept(contact: Contact, ticket: string) : Promise<any>

  /**
   * Room
   */
  public abstract roomAdd(room: Room, contact: Contact)              : Promise<number>
  public abstract roomDel(room: Room, contact: Contact)              : Promise<number>
  public abstract roomTopic(room: Room, topic: string)               : Promise<string>
  public abstract roomCreate(contactList: Contact[], topic?: string) : Promise<Room>
  public abstract roomFind(filterFunc: string)                       : Promise<Room[]>

  /**
   * Contact
   */
  public abstract contactFind(filterFunc: string)                    : Promise<Contact[]>
  public abstract contactAlias(contact: Contact, alias: string|null) : Promise<boolean>
}

/**
 * <error>
 *  <ret>1203</ret>
 *  <message>当前登录环境异常。为了你的帐号安全，暂时不能登录web微信。你可以通过手机客户端或者windows微信登录。</message>
 * </error>
 */
// export enum WechatErrorCode {
//   WebBlock = 1203,
// }

// export class WechatError extends Error {
//   public code: WechatErrorCode
// }

export default Puppet
