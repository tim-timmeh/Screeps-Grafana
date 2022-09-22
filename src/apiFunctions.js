import http from 'http'
import https from 'https'
import net from 'net'
import util from 'util'
import zlib from 'zlib'
const gunzipAsync = util.promisify(zlib.gunzip)

import { createLogger, format, transports } from 'winston';
const { combine, timestamp, prettyPrint } = format;

const logger = createLogger({
     format: combine(
          timestamp(),
          prettyPrint()
     ),
     transports: [new transports.File({ filename: "api.log" })]
})

async function gz(data) {
     const buf = Buffer.from(data.slice(3), 'base64')
     const ret = await gunzipAsync(buf)
     return JSON.parse(ret.toString())
}

let privateHost = undefined;
let forcedHost = undefined;

function getPrivateHost() {
     return new Promise(resolve => {
          const hosts = [
               ['localhost', 21025],
               ['host.docker.internal', 21025],
               ['172.17.0.1', 21025],
          ]
          let checkHostCount = 0;
          for (let i = 0; i < hosts.length; i++) {
               const host = hosts[i];
               var sock = new net.Socket()
               sock.setTimeout(2500)
               sock.on('connect', function () {
                    sock.destroy()
                    resolve(host[0])
               })
                    .on('error', function (e) {
                         checkHostCount += 1
                         if (checkHostCount == 3) resolve(undefined)
                    })
                    .on('timeout', function (e) {
                         checkHostCount += 1
                         if (checkHostCount == 3) resolve(undefined)
                    })
                    .connect(host[1], host[0])
          }
     })
}

async function getHost(type) {
     if (forcedHost) return forcedHost
     if (type === 'mmo') return 'screeps.com'
     if (!privateHost) privateHost = await getPrivateHost() || 'localhost';
     return privateHost
}

async function getRequestOptions(info, path, method = 'GET', body = {}) {
     const headers = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(JSON.stringify(body)),
     }

     if (info.username) headers['X-Username'] = info.username
     if (info.token) headers['X-Token'] = info.token
     return {
          host: await getHost(info.type),
          port: info.type === 'mmo' ? 443 : 21025,
          path,
          method,
          headers,
          body,
          isHTTPS: info.type === 'mmo',
     }
}
async function req(options) {
     const reqBody = JSON.stringify(options.body)
     const isHTTPS = options.isHTTPS
     delete options.body
     delete options.isHTTPS

     let maxTime = new Promise((resolve, reject) => {
          setTimeout(resolve, 10 * 1000, 'Timeout')
     })

     const executeReq = new Promise((resolve, reject) => {
          const req = (isHTTPS ? https : http).request(options, res => {
               res.setEncoding('utf8')
               let body = ''
               res.on('data', chunk => {
                    body += chunk
               })
               res.on('end', () => {
                    try {
                         body = JSON.parse(body)
                         resolve(body)
                    } catch {
                         resolve(body)
                    }
               })
          })
          req.write(reqBody)
          req.on('error', err => {
               reject(err)
          })
          req.end()
     })

     return await Promise.race([executeReq, maxTime])
          .then(result => {
               if (result === 'Timeout') {
                    logger.log('info', 'Timeout hit!', new Date(), JSON.stringify(options), reqBody)
                    return
               }
               // is result string
               if (typeof result === 'string' && result.startsWith("Rate limit exceeded")) logger.log('error', { data: result, options })
               else logger.log('info', { data: `${JSON.stringify(result).length / 1000} MB`, options })
               return result
          })
          .catch(result => {
               logger.log('error', { data: result, options })
          })
}

export default class {
     static async getPrivateServerToken(username, password) {
          const options = await getRequestOptions({ type: 'private', username }, '/api/auth/signin', 'POST', {
               email: username,
               password,
          })
          const res = await req(options)
          if (!res) return
          return res.token
     }
     static async getMemory(info, shard, statsPath = "stats") {
          const options = await getRequestOptions(info, `/api/user/memory?path=${statsPath}&shard=${shard}`, 'GET')
          const res = await req(options)
          if (!res) return
          return await gz(res.data)
     }
     static async getUserinfo(info) {
          const options = await getRequestOptions(info, `/api/auth/me`, 'GET')
          const res = await req(options)
          return res
     }
     static async getLeaderboard(info) {
          const options = await getRequestOptions(info, `/api/leaderboard/find?username=${info.username}&mode=world`, 'GET')
          const res = await req(options)
          return res
     }

     static async getUsers() {
          const options = await getRequestOptions({}, `/api/stats/users`, 'GET')
          const res = await req(options)
          return res
     }
     static async getRoomsObjects() {
          const options = await getRequestOptions({}, `/api/stats/rooms/objects`, 'GET')
          const res = await req(options)
          return res
     }
}