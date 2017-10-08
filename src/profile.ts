import * as fs    from 'fs'
import * as path  from 'path'

import {
  config,
  log,
}           from './config'

export type ProfileSection = 'cookies'

export interface ProfileSchema {
  cookies?:   any[]
}

export class Profile {
  private obj  : ProfileSchema
  private file : string | null

  constructor(
    public name: string = config.profile,
  ) {
    log.verbose('Profile', 'constructor(%s)', name)

    if (!name) {
      this.file = null
    } else {
      this.file = path.isAbsolute(name)
        ? name
        : path.join(
            process.cwd(),
            name + '.wechaty.json',
          )
    }
  }

  public load(): void {
    log.verbose('Profile', 'load() file: %s', this.file)
    if (!this.file) {
      return
    }

    if (!fs.existsSync(this.file)) {
      return
    }

    const text = fs.readFileSync(this.file).toString()
    try {
      this.obj = JSON.parse(text)
    } catch (e) {
      log.error('Profile', 'load() exception: %s', e)
      this.obj = {}
    }
  }

  public save(): void {
    log.verbose('Profile', 'save() file: %s', this.file)
    if (!this.file || !this.obj) {
      return
    }

    try {
      const text = JSON.stringify(this.obj)
      fs.writeFileSync(this.file, text)
    } catch (e) {
      log.error('Profile', 'save() exception: %s', e)
      throw e
    }
  }

  public get(section: ProfileSection): null | any {
    log.verbose('Profile', 'get(%s)', section)
    if (!this.obj) {
      return null
    }
    return this.obj[section]
  }

  public set(section: ProfileSection, data: any): void {
    log.verbose('Profile', 'set(%s, %s)', section, data)
    if (!this.obj) {
      return
    }
    this.obj[section] = data
  }

  public destroy(): void {
    log.verbose('Profile', 'destroy() file: %s', this.file)
    if (this.file && fs.existsSync(this.file)) {
      fs.unlinkSync(this.file)
    }
  }
}

export default Profile
