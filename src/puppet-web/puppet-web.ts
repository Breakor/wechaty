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
import {
  Watchdog,
  WatchdogFood,
}                   from 'watchdog'

import {
  config,
  log,
  Raven,
}                   from '../config'
import Contact      from '../contact'
import {
  Message,
  MediaMessage,
}                   from '../message'
import Profile      from '../profile'
import {
  Puppet,
  PuppetOptions,
  ScanInfo,
}                    from '../puppet'
import Room          from '../room'
import RxQueue       from '../rx-queue'
import Misc          from '../misc'

import {
  Bridge,
  Cookie,
}                    from './bridge'
import Event         from './event'

import {
  MediaData,
  MsgRawObj,
  MediaType,
}                     from './schema'

import * as request from 'request'
import * as bl from 'bl'

export type PuppetFoodType = 'scan' | 'ding'
export type ScanFoodType   = 'scan' | 'login' | 'logout'

export class PuppetWeb extends Puppet {
  public bridge   : Bridge
  public scanInfo : ScanInfo | null

  public puppetWatchdog : Watchdog<PuppetFoodType>
  public scanWatchdog   : Watchdog<ScanFoodType>

  private fileId   : number

  constructor(
    public options: PuppetOptions,
  ) {
    super(options)
    this.fileId = 0

    const PUPPET_TIMEOUT = 60 * 1000  // 1 minute
    this.puppetWatchdog = new Watchdog<PuppetFoodType>(PUPPET_TIMEOUT, 'PuppetWeb')

    const SCAN_TIMEOUT = 4 * 60 * 1000 // 4 minutes
    this.scanWatchdog   = new Watchdog<ScanFoodType>(SCAN_TIMEOUT, 'Scan')
  }

  public toString() { return `Class PuppetWeb({profile:${this.options.profile}})` }

  public async init(): Promise<void> {
    log.verbose('PuppetWeb', `init() with profile:${this.options.profile.name}`)

    this.state.target('live')
    this.state.current('live', false)

    try {
      this.initWatchdogForPuppet()
      this.initWatchdogForScan()

      this.bridge = await this.initBridge(this.options.profile)
      log.verbose('PuppetWeb', 'initBridge() done')

      const clicked = await this.bridge.clickSwitchAccount()
      if (clicked) {
        log.verbose('PuppetWeb', 'init() bridge.clickSwitchAccount() clicked')
      }

      /**
       *  state must set to `live`
       *  before feed Watchdog
       */
      this.state.current('live')

      const food: WatchdogFood = {
        data: 'inited',
        timeout: 2 * 60 * 1000, // 2 mins for first login
      }
      this.emit('watchdog', food)

      const throttleQueue = new RxQueue('throttle', 5 * 60 * 1000)
      this.on('heartbeat', data => throttleQueue.emit('i', data))
      throttleQueue.on('o', async () => {
        log.verbose('Wechaty', 'init() throttleQueue.on(o)')
        await this.saveCookie()
      })

      log.verbose('PuppetWeb', 'init() done')
      return

    } catch (e) {
      log.error('PuppetWeb', 'init() exception: %s', e)

      this.state.target('dead')
      this.emit('error', e)
      await this.quit()

      Raven.captureException(e)
      throw e
    }
  }

  public initWatchdogForPuppet(): void {
    const puppet = this
    const dog    = this.puppetWatchdog

    puppet.on('ding', data => this.puppetWatchdog.feed({
      data,
      type: 'ding',
    }))

    dog.on('feed', food => {
      // feed the rat, heartbeat the puppet.
      puppet.emit('heartbeat', food.data)
    })

    dog.on('reset', (food, left) => {
      const e = new Error(`PuppetWeb Watchdog Reset, last food: ${food.data}`)
      puppet.emit('error', e)
    })
  }

  /**
   * Deal with SCAN events
   *
   * if web browser stay at login qrcode page long time,
   * sometimes the qrcode will not refresh, leave there expired.
   * so we need to refresh the page after a while
   */
  public initWatchdogForScan(): void {
    const puppet = this
    const dog    = this.scanWatchdog

    puppet.on('scan', info => dog.feed({
      data: info,
      type: 'scan',
    }))
    puppet.on('login',  user => {
      dog.feed({
        data: user,
        type: 'login',
      })
      // do not monitor `scan` event anymore
      // after user login
      dog.sleep()
    })

    // active monitor again for `scan` event
    puppet.on('logout', user => dog.feed({
      data: user,
      type: 'logout',
    }))

    dog.on('reset', async () => {
      try {
        await this.bridge.reload()
      } catch (e) {
        log.error('PuppetWeb', 'initScanWatchdog() on(reset) exception: %s', e)
        this.emit('error', e)
      }
    })
  }

  public async quit(): Promise<void> {
    log.verbose('PuppetWeb', 'quit() state target(%s) current(%s) stable(%s)',
                             this.state.target(),
                             this.state.current(),
                             this.state.stable(),
    )

    if (this.state.current() === 'dead') {
      if (this.state.inprocess()) {
        const e = new Error('quit() is called on a `dead` `inprocess()` PuppetWeb')
        log.warn('PuppetWeb', e.message)
        throw e
      } else {
        log.warn('PuppetWeb', 'quit() is called on a `dead` browser. return directly.')
        return
      }
    }

    log.verbose('PuppetWeb', 'quit() kill watchdog before do quit')
    this.puppetWatchdog.sleep()

    this.state.target('dead')
    this.state.current('dead', false)

    try {
      if (this.bridge) {
        await this.bridge.quit()
      } else {
        log.warn('PuppetWeb', 'quit() no bridge!')
      }
    } catch (e) {
      log.error('PuppetWeb', 'quit() exception: %s', e.message)
      Raven.captureException(e)
      throw e
    } finally {
      this.state.current('dead')
    }
  }

  public async initBridge(profile: Profile): Promise<Bridge> {
    log.verbose('PuppetWeb', 'initBridge()')

    if (this.state.target() === 'dead') {
      const e = new Error('initBridge() found targetState != live, no init anymore')
      log.warn('PuppetWeb', e.message)
      throw e
    }

    const head = config.head
    // we have to set this.bridge right now,
    // because the Event.onXXX might arrive while we are initializing.
    this.bridge = new Bridge({
      head,
      profile,
    })

    this.bridge.on('ding'     , Event.onDing.bind(this))
    this.bridge.on('log'      , Event.onLog.bind(this))
    this.bridge.on('login'    , Event.onLogin.bind(this))
    this.bridge.on('logout'   , Event.onLogout.bind(this))
    this.bridge.on('message'  , Event.onMessage.bind(this))
    this.bridge.on('scan'     , Event.onScan.bind(this))

    try {
      await this.bridge.init()
    } catch (e) {
      const text = await this.bridge.evaluate('document.body.innerHTML')
      try {
        await this.bridge.testBlockedMessage(text)
        log.error('PuppetWeb', 'initBridge() exception: %s', e.message)
        Raven.captureException(e)
        this.emit('error', e)
      } catch (blockedError) {
        this.emit('error', blockedError)
      }
    }

    return this.bridge
  }

  public reset(reason?: string): void {
    log.verbose('PuppetWeb', 'reset(%s)', reason)

    this.bridge.quit().then(async () => {
      try {
        await this.bridge.init()
        log.silly('PuppetWeb', 'reset() done')
      } catch (e) {
        log.error('PuppetWeb', 'reset(%s) bridge.init() reject: %s', reason, e)
        this.emit('error', e)
      }
    }).catch(err => {
      log.error('PuppetWeb', 'reset(%s) bridge.quit() reject: %s', reason, err)
      this.emit('error', err)
    })
  }

  public logined(): boolean {
    return !!(this.user)
  }

  /**
   * get self contact
   */
  public self(): Contact {
    log.verbose('PuppetWeb', 'self()')

    if (this.user) {
      return this.user
    }
    throw new Error('PuppetWeb.self() no this.user')
  }

  private async getBaseRequest(): Promise<any> {
    try {
      const json = await this.bridge.getBaseRequest()
      const obj = JSON.parse(json)
      return obj.BaseRequest
    } catch (e) {
      log.error('PuppetWeb', 'send() exception: %s', e.message)
      Raven.captureException(e)
      throw e
    }
  }

  private async uploadMedia(mediaMessage: MediaMessage, toUserName: string): Promise<MediaData> {
    if (!mediaMessage)
      throw new Error('require mediaMessage')

    const filename = mediaMessage.filename()
    const ext      = mediaMessage.ext()

    // const contentType = Misc.mime(ext)
    // const contentType = mime.getType(ext)
    const contentType = mediaMessage.mimeType()
    if (!contentType) {
      throw new Error('no MIME Type found on mediaMessage: ' + mediaMessage.filename())
    }
    let mediatype: MediaType

    switch (ext) {
      case 'bmp':
      case 'jpeg':
      case 'jpg':
      case 'png':
      case 'gif':
        mediatype = MediaType.IMAGE
        break
      case 'mp4':
        mediatype = MediaType.VIDEO
        break
      default:
        mediatype = MediaType.ATTACHMENT
    }

    const readStream = await mediaMessage.readyStream()
    const buffer = <Buffer>await new Promise((resolve, reject) => {
      readStream.pipe(bl((err, data) => {
        if (err) reject(err)
        else resolve(data)
      }))
    })

    // Sending video files is not allowed to exceed 20MB
    // https://github.com/Chatie/webwx-app-tracker/blob/7c59d35c6ea0cff38426a4c5c912a086c4c512b2/formatted/webwxApp.js#L1115
    const MAX_FILE_SIZE   = 100 * 1024 * 1024
    const LARGE_FILE_SIZE = 25 * 1024 * 1024
    const MAX_VIDEO_SIZE  = 20 * 1024 * 1024

    if (mediatype === MediaType.VIDEO && buffer.length > MAX_VIDEO_SIZE)
      throw new Error(`Sending video files is not allowed to exceed ${MAX_VIDEO_SIZE / 1024 / 1024}MB`)
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`Sending files is not allowed to exceed ${MAX_FILE_SIZE / 1024 / 1024}MB`)
    }

    const md5 = Misc.md5(buffer)

    const baseRequest     = await this.getBaseRequest()
    const passTicket      = await this.bridge.getPassticket()
    const uploadMediaUrl  = await this.bridge.getUploadMediaUrl()
    const checkUploadUrl  = await this.bridge.getCheckUploadUrl()
    const cookie          = await this.bridge.cookies()
    const first           = cookie.find(c => c.name === 'webwx_data_ticket')
    const webwxDataTicket = first && first.value
    const size            = buffer.length
    const fromUserName    = this.self().id
    const id              = 'WU_FILE_' + this.fileId
    this.fileId++

    const hostname = await this.bridge.hostname()
    const headers = {
      Referer: `https://${hostname}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.102 Safari/537.36',
      Cookie: cookie.map(c => c.name + '=' + c.value).join('; '),
    }

    log.silly('PuppetWeb', 'uploadMedia() headers:%s', JSON.stringify(headers))

    const uploadMediaRequest = {
      BaseRequest:   baseRequest,
      FileMd5:       md5,
      FromUserName:  fromUserName,
      ToUserName:    toUserName,
      UploadType:    2,
      ClientMediaId: +new Date,
      MediaType:     MediaType.ATTACHMENT,
      StartPos:      0,
      DataLen:       size,
      TotalLen:      size,
      Signature:     '',
      AESKey:        '',
    }

    const checkData = {
      BaseRequest:  baseRequest,
      FromUserName: fromUserName,
      ToUserName:   toUserName,
      FileName:     filename,
      FileSize:     size,
      FileMd5:      md5,
      FileType:     7,              // If do not have this parameter, the api will fail
    }

    const mediaData = {
      ToUserName: toUserName,
      MediaId:    '',
      FileName:   filename,
      FileSize:   size,
      FileMd5:    md5,
      MMFileExt:  ext,
    } as MediaData

    // If file size > 25M, must first call checkUpload to get Signature and AESKey, otherwise it will fail to upload
    // https://github.com/Chatie/webwx-app-tracker/blob/7c59d35c6ea0cff38426a4c5c912a086c4c512b2/formatted/webwxApp.js#L1132 #1182
    if (size > LARGE_FILE_SIZE) {
      let ret
      try {
        ret = <any> await new Promise((resolve, reject) => {
          const r = {
            url: `https://${hostname}${checkUploadUrl}`,
            headers,
            json: checkData,
          }
          request.post(r, function (err, res, body) {
            try {
              if (err) {
                reject(err)
              } else {
                let obj = body
                if (typeof body !== 'object') {
                  log.silly('PuppetWeb', 'updateMedia() typeof body = %s', typeof body)
                  try {
                    obj = JSON.parse(body)
                  } catch (e) {
                    log.error('PuppetWeb', 'updateMedia() body = %s', body)
                    log.error('PuppetWeb', 'updateMedia() exception: %s', e)
                    this.emit('error', e)
                  }
                }
                if (typeof obj !== 'object' || obj.BaseResponse.Ret !== 0) {
                  const errMsg = obj.BaseResponse || 'api return err'
                  log.silly('PuppetWeb', 'uploadMedia() checkUpload err:%s \nreq:%s\nret:%s', JSON.stringify(errMsg), JSON.stringify(r), body)
                  reject(new Error('chackUpload err:' + JSON.stringify(errMsg)))
                }
                resolve({
                  Signature : obj.Signature,
                  AESKey    : obj.AESKey,
                })
              }
            } catch (e) {
              reject(e)
            }
          })
        })
      } catch (e) {
        log.error('PuppetWeb', 'uploadMedia() checkUpload exception: %s', e.message)
        throw e
      }
      if (!ret.Signature) {
        log.error('PuppetWeb', 'uploadMedia(): chackUpload failed to get Signature')
        throw new Error('chackUpload failed to get Signature')
      }
      uploadMediaRequest.Signature = ret.Signature
      uploadMediaRequest.AESKey    = ret.AESKey
      mediaData.Signature          = ret.Signature
    } else {
      delete uploadMediaRequest.Signature
      delete uploadMediaRequest.AESKey
    }

    log.verbose('PuppetWeb', 'uploadMedia() webwx_data_ticket: %s', webwxDataTicket)
    log.verbose('PuppetWeb', 'uploadMedia() pass_ticket: %s', passTicket)

    const formData = {
      id,
      name: filename,
      type: contentType,
      lastModifiedDate: Date().toString(),
      size,
      mediatype,
      uploadmediarequest: JSON.stringify(uploadMediaRequest),
      webwx_data_ticket: webwxDataTicket,
      pass_ticket: passTicket || '',
      filename: {
        value: buffer,
        options: {
          filename,
          contentType,
          size,
        },
      },
    }
    let mediaId
    try {
      mediaId = <string>await new Promise((resolve, reject) => {
        try {
          request.post({
            url: uploadMediaUrl + '?f=json',
            headers,
            formData,
          }, function (err, res, body) {
            if (err) { reject(err) }
            else {
              let obj = body
              if (typeof body !== 'object') {
                obj = JSON.parse(body)
              }
              resolve(obj.MediaId || '')
            }
          })
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      log.error('PuppetWeb', 'uploadMedia() uploadMedia exception: %s', e.message)
      throw new Error('uploadMedia err: ' + e.message)
    }
    if (!mediaId) {
      log.error('PuppetWeb', 'uploadMedia(): upload fail')
      throw new Error('PuppetWeb.uploadMedia(): upload fail')
    }
    return Object.assign(mediaData, { MediaId: mediaId as string })
  }

  public async sendMedia(message: MediaMessage): Promise<boolean> {
    const to   = message.to()
    const room = message.room()

    let destinationId

    if (room) {
      destinationId = room.id
    } else {
      if (!to) {
        throw new Error('PuppetWeb.sendMedia(): message with neither room nor to?')
      }
      destinationId = to.id
    }

    let mediaData: MediaData
    const rawObj = message.rawObj as MsgRawObj
    if (!rawObj.MediaId) {
      try {
        mediaData = await this.uploadMedia(message, destinationId)
        message.rawObj = Object.assign(rawObj, mediaData)
        log.silly('PuppetWeb', 'Upload completed, new rawObj:%s', JSON.stringify(message.rawObj))
      } catch (e) {
        log.error('PuppetWeb', 'sendMedia() exception: %s', e.message)
        return false
      }
    } else {
      // To support forward file
      log.silly('PuppetWeb', 'skip upload file, rawObj:%s', JSON.stringify(rawObj))
      mediaData = {
        ToUserName : destinationId,
        MediaId    : rawObj.MediaId,
        MsgType    : rawObj.MsgType,
        FileName   : rawObj.FileName,
        FileSize   : rawObj.FileSize,
        MMFileExt  : rawObj.MMFileExt,
      }
      if (rawObj.Signature) {
        mediaData.Signature = rawObj.Signature
      }
    }
    // console.log('mediaData.MsgType', mediaData.MsgType)
    // console.log('rawObj.MsgType', message.rawObj && message.rawObj.MsgType)

    mediaData.MsgType = Misc.msgType(message.ext())
    log.silly('PuppetWeb', 'sendMedia() destination: %s, mediaId: %s, MsgType; %s)',
      destinationId,
      mediaData.MediaId,
      mediaData.MsgType,
    )
    let ret = false
    try {
      ret = await this.bridge.sendMedia(mediaData)
    } catch (e) {
      log.error('PuppetWeb', 'sendMedia() exception: %s', e.message)
      Raven.captureException(e)
      return false
    }
    return ret
  }

  /**
   * TODO: Test this function if it could work...
   */
  // public async forward(baseData: MsgRawObj, patchData: MsgRawObj): Promise<boolean> {
  public async forward(message: MediaMessage, sendTo: Contact | Room): Promise<boolean> {

    log.silly('PuppetWeb', 'forward() to: %s, message: %s)',
      sendTo, message.filename(),
      // patchData.ToUserName,
      // patchData.MMActualContent,
    )

    if (!message.rawObj) {
      throw new Error('no rawObj')
    }

    let m = Object.assign({}, message.rawObj)
    const newMsg = <MsgRawObj>{}
    const largeFileSize = 25 * 1024 * 1024
    // let ret = false
    // if you know roomId or userId, you can use `Room.load(roomId)` or `Contact.load(userId)`
    // let sendToList: Contact[] = [].concat(sendTo as any || [])
    // sendToList = sendToList.filter(s => {
    //   if ((s instanceof Room || s instanceof Contact) && s.id) {
    //     return true
    //   }
    //   return false
    // }) as Contact[]
    // if (sendToList.length < 1) {
    //   throw new Error('param must be Room or Contact and array')
    // }
    if (m.FileSize >= largeFileSize && !m.Signature) {
      // if has RawObj.Signature, can forward the 25Mb+ file
      log.warn('MediaMessage', 'forward() Due to webWx restrictions, more than 25MB of files can not be downloaded and can not be forwarded.')
      return false
    }

    newMsg.FromUserName         = this.userId || ''
    newMsg.isTranspond          = true
    newMsg.MsgIdBeforeTranspond = m.MsgIdBeforeTranspond || m.MsgId
    newMsg.MMSourceMsgId        = m.MsgId
    // In room msg, the content prefix sender:, need to be removed, otherwise the forwarded sender will display the source message sender, causing self () to determine the error
    newMsg.Content      = Misc.unescapeHtml(m.Content.replace(/^@\w+:<br\/>/, '')).replace(/^[\w\-]+:<br\/>/, '')
    newMsg.MMIsChatRoom = sendTo instanceof Room ? true : false

    // The following parameters need to be overridden after calling createMessage()

    m = Object.assign(m, newMsg)
    // for (let i = 0; i < sendToList.length; i++) {
      // newMsg.ToUserName = sendToList[i].id
      // // all call success return true
      // ret = (i === 0 ? true : ret) && await config.puppetInstance().forward(m, newMsg)
    // }
    newMsg.ToUserName = sendTo.id
    // ret = await config.puppetInstance().forward(m, newMsg)
    // return ret
    const baseData  = m
    const patchData = newMsg

    let ret = false
    try {
      ret = await this.bridge.forward(baseData, patchData)
    } catch (e) {
      log.error('PuppetWeb', 'forward() exception: %s', e.message)
      Raven.captureException(e)
      throw e
    }
    return ret
  }

   public async send(message: Message | MediaMessage): Promise<boolean> {
    const to   = message.to()
    const room = message.room()

    let destinationId

    if (room) {
      destinationId = room.id
    } else {
      if (!to) {
        throw new Error('PuppetWeb.send(): message with neither room nor to?')
      }
      destinationId = to.id
    }

    let ret = false

    if (message instanceof MediaMessage) {
      ret = await this.sendMedia(message)
    } else {
      const content = message.content()

      log.silly('PuppetWeb', 'send() destination: %s, content: %s)',
        destinationId,
        content,
      )

      try {
        ret = await this.bridge.send(destinationId, content)
      } catch (e) {
        log.error('PuppetWeb', 'send() exception: %s', e.message)
        Raven.captureException(e)
        throw e
      }
    }
    return ret
  }

  /**
   * Bot say...
   * send to `filehelper` for notice / log
   */
  public async say(content: string): Promise<boolean> {
    if (!this.logined()) {
      throw new Error('can not say before login')
    }

    if (!content) {
      log.warn('PuppetWeb', 'say(%s) can not say nothing', content)
      return false
    }

    const m = new Message()
    m.to('filehelper')
    m.content(content)

    return await this.send(m)
  }

  /**
   * logout from browser, then server will emit `logout` event
   */
  public async logout(): Promise<void> {
    log.verbose('PuppetWeb', 'logout()')

    const data = this.user || this.userId || ''
    this.userId = this.user = null

    this.emit('logout', data)

    try {
      await this.bridge.logout()
    } catch (e) {
      log.error('PuppetWeb', 'logout() exception: %s', e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async getContact(id: string): Promise<object> {
    try {
      return await this.bridge.getContact(id)
    } catch (e) {
      log.error('PuppetWeb', 'getContact(%d) exception: %s', id, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async ding(data?: any): Promise<string> {
    try {
      return await this.bridge.ding(data)
    } catch (e) {
      log.warn('PuppetWeb', 'ding(%s) rejected: %s', data, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async contactAlias(contact: Contact, remark: string|null): Promise<boolean> {
    try {
      const ret = await this.bridge.contactRemark(contact.id, remark)
      if (!ret) {
        log.warn('PuppetWeb', 'contactRemark(%s, %s) bridge.contactRemark() return false',
                              contact.id, remark,
        )
      }
      return ret

    } catch (e) {
      log.warn('PuppetWeb', 'contactRemark(%s, %s) rejected: %s', contact.id, remark, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async contactFind(filterFunc: string): Promise<Contact[]> {
    try {
      const idList = await this.bridge.contactFind(filterFunc)
      return idList.map(id => Contact.load(id))
    } catch (e) {
      log.warn('PuppetWeb', 'contactFind(%s) rejected: %s', filterFunc, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async roomFind(filterFunc: string): Promise<Room[]> {
    try {
      const idList = await this.bridge.roomFind(filterFunc)
      return idList.map(id => Room.load(id))
    } catch (e) {
      log.warn('PuppetWeb', 'roomFind(%s) rejected: %s', filterFunc, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async roomDel(room: Room, contact: Contact): Promise<number> {
    const roomId    = room.id
    const contactId = contact.id
    try {
      return await this.bridge.roomDelMember(roomId, contactId)
    } catch (e) {
      log.warn('PuppetWeb', 'roomDelMember(%s, %d) rejected: %s', roomId, contactId, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async roomAdd(room: Room, contact: Contact): Promise<number> {
    const roomId    = room.id
    const contactId = contact.id
    try {
      return await this.bridge.roomAddMember(roomId, contactId)
    } catch (e) {
      log.warn('PuppetWeb', 'roomAddMember(%s) rejected: %s', contact, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async roomTopic(room: Room, topic: string): Promise<string> {
    if (!room || typeof topic === 'undefined') {
      return Promise.reject(new Error('room or topic not found'))
    }

    const roomId = room.id
    try {
      return await this.bridge.roomModTopic(roomId, topic)
    } catch (e) {
      log.warn('PuppetWeb', 'roomTopic(%s) rejected: %s', topic, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async roomCreate(contactList: Contact[], topic: string): Promise<Room> {
    if (!contactList || ! contactList.map) {
      throw new Error('contactList not found')
    }

    const contactIdList = contactList.map(c => c.id)

    try {
      const roomId = await this.bridge.roomCreate(contactIdList, topic)
      if (!roomId) {
        throw new Error('PuppetWeb.roomCreate() roomId "' + roomId + '" not found')
      }
      return  Room.load(roomId)

    } catch (e) {
      log.warn('PuppetWeb', 'roomCreate(%s, %s) rejected: %s', contactIdList.join(','), topic, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  /**
   * FriendRequest
   */
  public async friendRequestSend(contact: Contact, hello: string): Promise<boolean> {
    if (!contact) {
      throw new Error('contact not found')
    }

    try {
      return await this.bridge.verifyUserRequest(contact.id, hello)
    } catch (e) {
      log.warn('PuppetWeb', 'bridge.verifyUserRequest(%s, %s) rejected: %s', contact.id, hello, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  public async friendRequestAccept(contact: Contact, ticket: string): Promise<boolean> {
    if (!contact || !ticket) {
      throw new Error('contact or ticket not found')
    }

    try {
      return await this.bridge.verifyUserOk(contact.id, ticket)
    } catch (e) {
      log.warn('PuppetWeb', 'bridge.verifyUserOk(%s, %s) rejected: %s', contact.id, ticket, e.message)
      Raven.captureException(e)
      throw e
    }
  }

  /**
   * @private
   * For issue #668
   */
  public async readyStable(): Promise<void> {
    log.verbose('PuppetWeb', 'readyStable()')
    let counter = -1

    async function stable(resolve: Function): Promise<void> {
      log.silly('PuppetWeb', 'readyStable() stable() counter=%d', counter)
      const contactList = await Contact.findAll()
      if (counter === contactList.length) {
        log.verbose('PuppetWeb', 'readyStable() stable() READY counter=%d', counter)
        return resolve()
      }
      counter = contactList.length
      setTimeout(() => stable(resolve), 1000)
        .unref()
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        log.warn('PuppetWeb', 'readyStable() stable() reject at counter=%d', counter)
        return reject(new Error('timeout after 60 seconds'))
      }, 60 * 1000)
      timer.unref()

      const myResolve = () => {
        clearTimeout(timer)
        resolve()
      }

      setTimeout(() => stable(myResolve), 1000)
    })

  }

  public async hostname(): Promise<string> {
    try {
      const name = await this.bridge.hostname()
      if (!name) {
        throw new Error('no hostname found')
      }
      return name
    } catch (e) {
      log.error('PuppetWeb', 'hostname() exception:%s', e)
      this.emit('error', e)
      throw e
    }
  }

  public async cookies(): Promise<Cookie[]> {
    return await this.bridge.cookies()
  }

  public async saveCookie(): Promise<void> {
    const cookieList = await this.bridge.cookies()
    this.options.profile.set('cookies', cookieList)
    this.options.profile.save()
  }
}

export default PuppetWeb
